const fs = require("fs-extra");
const path = require("path");
const Express = require("express");
const ejs = require("ejs");
const bcrypt = require("bcrypt-promise");
const crypto = require('crypto');
const base64url = require('base64url');
const sanitizer = require('sanitizer');

const pmSockets = [];

class masterPlugin {
	constructor({config, pluginConfig, pluginPath, socketio, express}){
		this.config = config;
		this.pluginConfig = pluginConfig;
		this.pluginPath = pluginPath;
		this.io = socketio;
		this.app = express;
		
		// load databases
		const database = getDatabaseSync(path.join(this.config.databaseDirectory, "playerManager.json"));
		this.whitelist = getDatabaseSync(path.join(this.config.databaseDirectory, "whitelist.json")).whitelist || [];
		this.banlist = getDatabaseSync(path.join(this.config.databaseDirectory, "banlist.json")).banlist || [];
		this.managedPlayers = database.managedPlayers || [];
		this.users = database.users || [];
		
		// autosave databases
		setInterval(async ()=>{
			await saveDatabase(path.join(this.config.databaseDirectory, "playerManager.json"), {
				managedPlayers: this.managedPlayers,
				users: this.users,
			});
			await saveDatabase(path.join(this.config.databaseDirectory, "whitelist.json"), {whitelist: this.whitelist});
			await saveDatabase(path.join(this.config.databaseDirectory, "banlist.json"), {banlist: this.banlist});
		}, 1000*60*5);
		
		this.clients = {};
		this.slaves = {};
		
		// initialize web API
		require("./js/api-endpoints.js")(this);
		require("./js/api-endpoints-player.js")(this);
		
		// initialize token auth module
		this.authenticate = require("./../../lib/authenticate.js")(config);
		
		// expose UI elements embedded in the master
		this.ui = require("./js/ui.js").ui;
		
		this.io.on("connection", socket => {
			let instanceID = "unknown";
			socket.on("registerSlave", data => {
				if(data.instanceID && !isNaN(Number(data.instanceID))){
					instanceID = data.instanceID;
					this.slaves[instanceID] = socket;
				}
			});
			socket.on("registerPlayerManager", () => {
				console.log("Registered playerManager socket")
				pmSockets.push(socket);
				this.pollForPlayers(socket, instanceID);
				
				socket.on("playerManagerSetPlayerdata", data => {
					let parsedData = this.parseData(data, {instanceID});
					this.handlePlayerdata(parsedData);
				});
				
				socket.on("disconnect", function () {
					let i = pmSockets.indexOf(socket);
					console.log("playerManager "+(i+1)+" disconnected, "+(pmSockets.length-1)+" left");
					pmSockets.splice(i, 1);
				});
			});
			socket.on("gameChat", async data => {
				let chatLine = data.data.replace(/(\r\n\t|\n|\r\t)/gm, "").replace("\r", "");
				if(typeof chatLine == "string") this.handleChatLine(chatLine, instanceID);
			});
		});
		
		// I can't seem to get express static pages + ejs rendering to work properly, so I write my own thing.
		let pages = [
			{
				addr: "/playerManager/index.html",
				path: path.join(__dirname,"static/index.html"),
				render: ejs
			},{
				addr: "/playerManager",
				path: path.join(__dirname,"static/index.html"),
				render: ejs
			},{
				addr: "/playerManager/whitelist",
				path: path.join(__dirname,"static/whitelist.html"),
				render: ejs
			},{
				addr: "/playerManager/register",
				path: path.join(__dirname,"static/register.html"),
				render: ejs
			},{
				addr: "/playerManager/login",
				path: path.join(__dirname,"static/login.html"),
				render: ejs
			},{
				addr: "/playerManager/profile",
				path: path.join(__dirname,"static/profile.html"),
				render: ejs
			},{
				addr: "/playerManager/account",
				path: path.join(__dirname,"static/account.html"),
				render: ejs
			},
		]
		pages.forEach(page => {
			this.app.get(page.addr, async (req,res) => {
				if(page.render){
					page.render.renderFile(page.path, (err, str) => {
						if(err) console.log(err);
						res.send(str);
					});
				} else {
					res.send(await fs.readFile(page.path));
				}
			});
		});
		this.app.use('/playerManager', Express.static(path.join(__dirname, 'static')));
	}
	async broadcastCommand(command){
		let returnValues = [];
		pmSockets.forEach(socket => socket.emit("runCommand", {
			// commandID:Math.random(),
			command,
		}));
		return returnValues;
	}
	findInArray(key, value, array){
		let indexes = [];
		for(let i in array){
			if(array[i][key] && array[i][key] === value) indexes.push(i);
		}
		return indexes;
	}
	async getPermissions(token, users){
		if(!users){
			users = this.users;
		}
		let permissions = {
			all:{
				read: [
					"name",
					"factorioName",
					"admin",
					"description",
				],
				write: [],
			},
			user:{
				
			},
			cluster:[],
			instance:{
				
			},
		};
		let authenticatedUser;
		for(let i in users){
			let user = users[i];
			for(let o in user.sessions){
				let session = user.sessions[o];
				
				if(session.token === token
				&& Date.now() < session.expiryDate){
					authenticatedUser = user;
					permissions.user[user.name] = {
						read: [
							"email",
							"factorioLinkToken",
						],
						write: [
							"password",
							"email",
							"description",
						],
					};
					if((user.admin && typeof user.admin == "boolean") || (user.admin == "true" && typeof user.admin == "string")){
						permissions = giveAdminPermissions(permissions);
					}
				} else if(Date.now() > session.expiryDate){
					// remove expired session
					console.log(`Removed session on timeout: ${session.token}`);
					user.sessions.splice(o, 1);
				}
			}
		}
		if((await this.authenticate.check(token)).ok){
			// The masterAuthToken overrides everything and always grants all permissions. Lets pretend this user is an admin.
			permissions = giveAdminPermissions(permissions);
			authenticatedUser = "master";
		}
		function giveAdminPermissions(permissions){
			permissions.all.read.push("email");
			permissions.all.read.push("factorioLinkToken");
			permissions.all.write.push("email");
			permissions.all.write.push("password");
			permissions.all.write.push("admin");
			permissions.cluster.push("whitelist");
			permissions.cluster.push("removeWhitelist");
			permissions.cluster.push("banlist");
			permissions.cluster.push("removeBanlist");
			permissions.cluster.push("addPlayer");
			permissions.cluster.push("editPlayer");
			permissions.cluster.push("deletePlayer");
			return permissions;
		}
		// run permissions middleware from other plugins
		for(let i in this.masterPlugins){
			let plugin = this.masterPlugins[i];
			if(plugin.main.onPlayerManagerGetPermissions && typeof plugin.main.onPlayerManagerGetPermissions){
				permissions = await plugin.main.onPlayerManagerGetPermissions({permissions, token, users, user: authenticatedUser});
			}
		}
		return permissions;
	}
	async onExit(){
		console.log(path.join(this.config.databaseDirectory, "playerManager.json"))
		await saveDatabase(path.join(this.config.databaseDirectory, "playerManager.json"), {
			managedPlayers: this.managedPlayers,
			users: this.users,
		});
		await saveDatabase(path.join(this.config.databaseDirectory, "whitelist.json"), {whitelist: this.whitelist});
		await saveDatabase(path.join(this.config.databaseDirectory, "banlist.json"), {banlist: this.banlist});
		return;
	}
	async onLoadFinish({plugins}){
		this.masterPlugins = plugins;
	}
	pollForPlayers(socket, instanceID){
		// console.log("Polling for players")
		if(pmSockets.indexOf(socket) == -1) return
		socket.emit("playerManagerGetPlayers");
		setTimeout(() => this.pollForPlayers(socket, instanceID), 1000);
	}
	parseData(data, sharedData){
		let parsedData = [];
		data = data.split("|");
		data.forEach(player => {
			if(player){
				let playerData = {};
				player = player.split(`~`);
				player.forEach(kv => {
					kv = kv.split(":");
					if(kv[1] === undefined || kv[0] === undefined){
						console.log(new Error(`Something is wrong! Key:${kv[0]} Value:${kv[1]}`));
					} else {
						playerData[kv[0]] = kv[1].trim();
					}
				});
				for(let k in sharedData){
					playerData[k] = sharedData[k];
				}
				parsedData.push(playerData);
			}
		});
		return parsedData;
	}
	handlePlayerdata(playerData){
		playerData.forEach(player => {
			for(let i = 0; i <= this.managedPlayers.length; i++){
				if(i == this.managedPlayers.length){
					console.log("New player joined! "+player.name);
					// we didn't find this player, a new person must have joined!
					this.managedPlayers.push({name: player.name});
				}
				if(this.managedPlayers[i].name == player.name){
					for(let key in player){
						this.managedPlayers[i][key] = player[key];
					}
					if(player.connected === "false"){
						if(this.managedPlayers[i].onlineTimeTotal == undefined) this.managedPlayers.onlineTimeTotal = 0;
						this.managedPlayers[i].onlineTimeTotal = (Number(this.managedPlayers[i].onlineTimeTotal) || 0) + (Number(player.onlineTime) || 0);
						// player.onlineTime will be reset by Lua on next reconnect by this player, but we force it now to make it easier to get an accurate count of playtime
						this.managedPlayers[i].onlineTime = 0;
					}
					break;
				}
			}
		});
	}
	async handleChatLine(line, instanceID){
		// chat lines are handled by ./commandHandler.js
		let cmdHandler = require("./commandHandler.js");
		let commandHandler = new cmdHandler(this, (command, instanceID) => {
			if(this.slaves[instanceID] && command && typeof command === "string"){
				console.log(command)
				this.slaves[instanceID].emit("runCommand", {command});
			}
		});
		if(line.indexOf("!playerManager")){
			let parsedMessage = line.substr(line.indexOf("!playerManager")).split(" ");
			if(commandHandler[parsedMessage[1]]){
				commandHandler[parsedMessage[1]](parsedMessage, instanceID, line);
			}
		}
	}
}
module.exports = masterPlugin;

function getDatabaseSync(path){
	let db;
	try {
		db = JSON.parse(fs.readFileSync(path, "utf8"));
	} catch(e){
		db = {};
	}
	return db;
}
async function saveDatabase(path, database){
	if(!path){
		throw new Error("No path provided!");
	} else if(!database){
		throw new Error("No database provided!");
	} else {
		try {
			await fs.writeFile(path, JSON.stringify(database, null, 4));
		} catch(e){
			throw new Error("Unable to write to database! "+path);
		}
	}
}
