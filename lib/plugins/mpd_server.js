var net = require('net');
var path = require('path');
var findit = require('findit');
var Player = require('../player');

module.exports = MpdServer;

var ERR_CODE_NOT_LIST = 1;
var ERR_CODE_ARG = 2;
var ERR_CODE_PASSWORD = 3;
var ERR_CODE_PERMISSION = 4;
var ERR_CODE_UNKNOWN = 5;
var ERR_CODE_NO_EXIST = 50;
var ERR_CODE_PLAYLIST_MAX = 51;
var ERR_CODE_SYSTEM = 52;
var ERR_CODE_PLAYLIST_LOAD = 53;
var ERR_CODE_UPDATE_ALREADY = 54;
var ERR_CODE_PLAYER_SYNC = 55;
var ERR_CODE_EXIST = 56;

var commands = {
  "add": addCmd,
  "addid": addidCmd,
  "channels": channelsCmd,
  "clear": clearCmd,
  "clearerror": clearerrorCmd,
  "close": closeCmd,
  "commands": commandsCmd,
  "config": configCmd,
  "consume": consumeCmd,
  "count": countCmd,
  "crossfade": crossfadeCmd,
  "currentsong": currentsongCmd,
  "decoders": decodersCmd,
  "delete": deleteCmd,
  "deleteid": deleteidCmd,
  "disableoutput": disableoutputCmd,
  "enableoutput": enableoutputCmd,
  "find": findCmd,
  "findadd": findaddCmd,
  "kill": killCmd,
  "list": listCmd,
  "listall": listallCmd,
  "listallinfo": listallinfoCmd,
  "listplaylist": listplaylistCmd,
  "listplaylistinfo": listplaylistinfoCmd,
  "listplaylists": listplaylistsCmd,
  "load": loadCmd,
  "lsinfo": lsinfoCmd,
  "mixrampdb": mixrampdbCmd,
  "mixrampdelay": mixrampdelayCmd,
  "move": moveCmd,
  "moveid": moveidCmd,
  "next": nextCmd,
  "notcommands": notcommandsCmd,
  "outputs": outputsCmd,
  "password": passwordCmd,
  "pause": pauseCmd,
  "ping": pingCmd,
  "play": playCmd,
  "playid": playidCmd,
  "playlist": playlistCmd,
  "playlistadd": playlistaddCmd,
  "playlistclear": playlistclearCmd,
  "playlistdelete": playlistdeleteCmd,
  "playlistfind": playlistfindCmd,
  "playlistid": playlistidCmd,
  "playlistinfo": playlistinfoCmd,
  "playlistmove": playlistmoveCmd,
  "playlistsearch": playlistsearchCmd,
  "plchanges": plchangesCmd,
  "plchangesposid": plchangesposidCmd,
  "previous": previousCmd,
  "prio": prioCmd,
  "prioid": prioidCmd,
  "random": randomCmd,
  "readmessages": readmessagesCmd,
  "rename": renameCmd,
  "repeat": repeatCmd,
  "replay_gain_mode": replay_gain_modeCmd,
  "replay_gain_status": replay_gain_statusCmd,
  "rescan": rescanCmd,
  "rm": rmCmd,
  "save": saveCmd,
  "search": searchCmd,
  "searchadd": searchaddCmd,
  "searchaddpl": searchaddplCmd,
  "seek": seekCmd,
  "seekcur": seekcurCmd,
  "seekid": seekidCmd,
  "sendmessage": sendmessageCmd,
  "setvol": setvolCmd,
  "shuffle": shuffleCmd,
  "single": singleCmd,
  "stats": statsCmd,
  "status": statusCmd,
  "sticker": stickerCmd,
  "stop": stopCmd,
  "subscribe": subscribeCmd,
  "swap": swapCmd,
  "swapid": swapidCmd,
  "tagtypes": tagtypesCmd,
  "unsubscribe": unsubscribeCmd,
  "update": updateCmd,
  "urlhandlers": urlhandlersCmd,
};

function MpdServer(gb) {
  this.gb = gb;
}

var stateCount = 0;
var STATE_CMD       = stateCount++;
var STATE_CMD_SPACE = stateCount++;
var STATE_ARG       = stateCount++;
var STATE_ARG_QUOTE = stateCount++;
var STATE_ARG_ESC   = stateCount++;

var cmdListStateCount = 0;
var CMD_LIST_STATE_NONE   = cmdListStateCount++;
var CMD_LIST_STATE_LIST   = cmdListStateCount++;

MpdServer.prototype.initialize = function(cb) {
  var self = this;
  var mpdPort = self.gb.config.mpdPort;
  var mpdHost = self.gb.config.mpdHost;
  if (mpdPort == null || mpdHost == null) {
    console.info("MPD Protocol disabled");
    cb();
    return;
  }
  self.bootTime = new Date();
  self.singleMode = false;
  var server = net.createServer(onSocketConnection);
  server.listen(mpdPort, mpdHost, function() {
    console.info("MPD Protocol listening at " + mpdHost + ":" + mpdPort);
    cb();
  });

  function onSocketConnection(socket) {
    var buffer = "";
    var cmdListState = CMD_LIST_STATE_NONE;
    var cmdList = [];
    var okMode = false;
    var isIdle = false;
    var commandQueue = [];
    var ongoingCommand = false;
    var updatedSubsystems = {
      database: false,
      update: false,
      stored_playlist: false,
      playlist: false,
      player: false,
      mixer: false,
      output: false,
      options: false,
      sticker: false,
      subscription: false,
      message: false,
    };

    socket.setEncoding('utf8');
    socket.write("OK MPD 0.17.0\n");
    socket.on('data', bufferStr);
    socket.on('error', onError);
    self.gb.player.on('volumeUpdate', onVolumeUpdate);
    self.gb.player.on('repeatUpdate', updateOptionsSubsystem);
    self.gb.player.on('dynamicModeUpdate', updateOptionsSubsystem);
    self.gb.player.on('playlistUpdate', onPlaylistUpdate);

    function onVolumeUpdate() {
      subsystemUpdate('mixer');
    }

    function onPlaylistUpdate() {
      // TODO make these updates more fine grained
      subsystemUpdate('playlist');
      subsystemUpdate('player');
    }

    function updateOptionsSubsystem() {
      subsystemUpdate('options');
    }

    function subsystemUpdate(subsystem) {
      updatedSubsystems[subsystem] = true;
      if (isIdle) handleIdle();
    }

    function onError(err) {
      console.warn("socket error:", err.message);
    }
    
    function bufferStr(str) {
      var lines = str.split(/\r?\n/);
      buffer += lines[0];
      if (lines.length === 1) return;
      handleLine(buffer);
      var lastIndex = lines.length - 1;
      for (var i = 1; i < lastIndex; i += 1) {
        handleLine(lines[i]);
      }
      buffer = lines[lastIndex];
    }

    function handleLine(line) {
      var state = STATE_CMD;
      var cmd = "";
      var args = [];
      var curArg = "";
      for (var i = 0; i < line.length; i += 1) {
        var c = line[i];
        switch (state) {
          case STATE_CMD:
            if (isSpace(c)) {
              state = STATE_CMD_SPACE;
            } else {
              cmd += c;
            }
            break;
          case STATE_CMD_SPACE:
            if (c === '"') {
              curArg = "";
              state = STATE_ARG_QUOTE;
            } else if (!isSpace(c)) {
              curArg = c;
              state = STATE_ARG;
            }
            break;
          case STATE_ARG:
            if (isSpace(c)) {
              args.push(curArg);
              curArg = "";
              state = STATE_CMD_SPACE;
            } else {
              curArg += c;
            }
            break;
          case STATE_ARG_QUOTE:
            if (c === '"') {
              args.push(curArg);
              curArg = "";
              state = STATE_CMD_SPACE;
            } else if (c === "\\") {
              state = STATE_ARG_ESC;
            } else {
              curArg += c;
            }
            break;
          case STATE_ARG_ESC:
            curArg += c;
            state = STATE_ARG_QUOTE;
            break;
          default:
            throw new Error("unrecognized state");
        }
      }
      if (state === STATE_ARG) {
        args.push(curArg);
      }
      commandQueue.push([cmd, args]);
      flushQueue();
    }

    function flushQueue() {
      if (ongoingCommand) return;
      var queueItem = commandQueue.shift();
      if (!queueItem) return;
      var cmd = queueItem[0];
      var args = queueItem[1];
      ongoingCommand = true;
      handleCommand(cmd, args, function() {
        ongoingCommand = false;
        flushQueue();
      });
    }

    function handleCommand(cmdName, args, cb) {
      var cmdIndex = 0;

      switch (cmdListState) {
        case CMD_LIST_STATE_NONE:
          if (cmdName === 'command_list_begin' && args.length === 0) {
            cmdListState = CMD_LIST_STATE_LIST;
            cmdList = [];
            okMode = false;
            cb();
            return;
          } else if (cmdName === 'command_list_ok_begin' && args.length === 0) {
            cmdListState = CMD_LIST_STATE_LIST;
            cmdList = [];
            okMode = true;
            cb();
            return;
          } else {
            runOneCommand(cmdName, args, 0, function(ok) {
              if (ok) socket.write("OK\n");
              cb();
            });
            return;
          }
          break;
        case CMD_LIST_STATE_LIST:
          if (cmdName === 'command_list_end' && args.length === 0) {
            cmdListState = CMD_LIST_STATE_NONE;

            runAndCheckOneCommand();
            return;

          } else {
            cmdList.push([cmdName, args]);
            cb();
            return;
          }
          break;
        default:
          throw new Error("unrecognized state");
      }

      function runAndCheckOneCommand() {
        var commandPayload = cmdList.shift();
        if (!commandPayload) {
          socket.write("OK\n");
          cb();
          return;
        }
        var thisCmdName = commandPayload[0];
        var thisCmdArgs = commandPayload[1];
        runOneCommand(thisCmdName, thisCmdArgs, cmdIndex++, function(ok) {
          if (!ok) {
            cb();
            return;
          } else if (okMode) {
            socket.write("list_OK\n");
          }
        });
      }
    }

    function runOneCommand(cmdName, args, index, cb) {
      if (cmdName === 'noidle') {
        handleNoIdle(args);
        cb(false);
        return;
      }
      if (isIdle) {
        socket.end();
        cb(false);
        return;
      }
      if (cmdName === 'idle') {
        handleIdle(args);
        cb(false);
        return;
      }
      execOneCommand(cmdName, args, cmdDone);

      function cmdDone(code, msg) {
        if (code) {
          if (/unimplemented/.test(msg)) {
            console.info("needed command:", cmdName, JSON.stringify(args));
          }
          if (code === ERR_CODE_UNKNOWN) cmdName = "";
          socket.write("ACK [" + code + "@" + index + "] {" + cmdName + "} " + msg + "\n");
          cb(false);
          return;
        }
        cb(true);
      }
    }

    function execOneCommand(cmdName, args, cb) {
      if (!cmdName.length) return cb(ERR_CODE_UNKNOWN, "No command given");
      var cmd = commands[cmdName];
      if (!cmd) return cb(ERR_CODE_UNKNOWN, "unknown command \"" + cmdName + "\"");
      if (cmd.length < 4) {
        var returnValue = cmd(self, socket, args);
        var code = returnValue && returnValue[0];
        var msg = returnValue && returnValue[1];
        cb(code, msg);
        return;
      }
      cmd(self, socket, args, cb);
    }

    function handleIdle(args) {
      var anyUpdated = false;
      for (var subsystem in updatedSubsystems) {
        var isUpdated = updatedSubsystems[subsystem];
        if (isUpdated) {
          socket.write("changed: " + subsystem + "\n");
          anyUpdated = true;
          updatedSubsystems[subsystem] = false;
        }
      }
      if (anyUpdated) {
        socket.write("OK\n");
        isIdle = false;
        return;
      }
      isIdle = true;
    }

    function handleNoIdle(args) {
      if (!isIdle) return;
      isIdle = false;
    }
  }
}

function isSpace(c) {
  return c === '\t' || c === ' ';
}

function parseBool(str) {
  return !!parseInt(str, 10);
}

function writeTrackInfo(socket, dbTrack) {
  socket.write("file: " + dbTrack.file + "\n");
  if (dbTrack.mtime != null) {
    socket.write("Last-Modified: " + new Date(dbTrack.mtime).toISOString() + "\n");
  }
  if (dbTrack.duration != null) {
    socket.write("Time: " + Math.round(dbTrack.duration) + "\n");
  }
  if (dbTrack.artistName != null) {
    socket.write("Artist: " + dbTrack.artistName + "\n");
  }
  if (dbTrack.albumName != null) {
    socket.write("Album: " + dbTrack.albumName + "\n");
  }
  if (dbTrack.albumArtistName != null) {
    socket.write("AlbumArtist: " + dbTrack.albumArtistName + "\n");
  }
  if (dbTrack.genre != null) {
    socket.write("Genre: " + dbTrack.genre + "\n");
  }
  if (dbTrack.name != null) {
    socket.write("Title: " + dbTrack.name + "\n");
  }
  if (dbTrack.track != null) {
    if (dbTrack.trackCount != null) {
      socket.write("Track: " + dbTrack.track + "/" + dbTrack.trackCount + "\n");
    } else {
      socket.write("Track: " + dbTrack.track + "\n");
    }
  }
  if (dbTrack.composerName != null) {
    socket.write("Composer: " + dbTrack.composerName + "\n");
  }
  if (dbTrack.disc != null) {
    if (dbTrack.discCount != null) {
      socket.write("Disc: " + dbTrack.disc + "/" + dbTrack.discCount + "\n");
    } else {
      socket.write("Disc: " + dbTrack.disc + "\n");
    }
  }
  if (dbTrack.year != null) {
    socket.write("Date: " + dbTrack.year + "\n");
  }
}

function addCmd(self, socket, args, cb) {
  if (args.length !== 1) return cb(ERR_CODE_ARG, "wrong number of arguments for \"add\"");

  var uri = args[0];
  var musicDir = self.gb.config.musicDirectory;

  var walker = findit(path.join(musicDir, uri));
  var files = [];
  walker.on('file', function(file) {
    files.push(file);
  });
  walker.on('error', function(err) {
    walker.removeAllListeners();
    console.error("unable to walk file system:", err.stack);
    cb(ERR_CODE_UNKNOWN, "Unknown error");
  });
  walker.on('end', function() {
    var keys = [];
    for (var i = 0; i < files.length; i += 1) {
      var file = files[i];
      var relPath = path.relative(musicDir, file);
      var dbFile = self.gb.player.dbFilesByPath[relPath];
      if (dbFile) keys.push(dbFile.key);
    }
    if (keys.length === 0) {
      cb(ERR_CODE_NO_EXIST, "Not found");
      return;
    }
    self.gb.player.appendTracks(keys, false);
    cb();
  });
}

function addidCmd(self, socket, args, cb) {
  var pos = self.gb.player.tracksInOrder.length;
  if (args.length > 2) {
    return cb(ERR_CODE_ARG, "too many arguments for \"addid\"");
  } else if (args.length === 2) {
    pos = parseInt(args[1], 10);
    if (isNaN(pos)) return cb(ERR_CODE_ARG, "Integer expected: " + args[1]);
  } else if (args.length === 0) {
    return cb(ERR_CODE_ARG, "wrong number of arguments for \"addid\"");
  }
  var uri = args[0];
  var dbFile = self.gb.player.dbFilesByPath[uri];
  if (!dbFile) return cb(ERR_CODE_NO_EXIST, "Not found");
  var ids = self.gb.player.insertTracks(pos, [dbFile.key], false);
  socket.write("Id: " + ids[0] + "\n");
  cb();
}

function channelsCmd(self, socket, args, cb) {
  cb();
}

function clearCmd(self, socket, args, cb) {
  self.gb.player.clearPlaylist();
  cb();
}

function clearerrorCmd(self, socket, args, cb) {
  cb();
}

function closeCmd(self, socket, args, cb) {
  socket.end();
  cb();
}

function commandsCmd(self, socket, args, cb) {
  var commandNames = Object.keys(commands);
  commandNames.push("idle");
  commandNames.sort();
  commandNames.forEach(function(commandName) {
    socket.write("command: " + commandName + "\n");
  });
  cb();
}

function configCmd(self, socket, args, cb) {
  cb(ERR_CODE_PERMISSION, "you don't have permission for \"config\"");
}

function consumeCmd(self, socket, args) {
  // TODO make this turn on/off dynamic mode
  return [ERR_CODE_UNKNOWN, "unimplemented"];
}

function countCmd(self, socket, args) {
  return [ERR_CODE_UNKNOWN, "unimplemented"];
}

function crossfadeCmd(self, socket, args) {
  return [ERR_CODE_UNKNOWN, "unimplemented"];
}

function currentsongCmd(self, socket, args) {
  return [ERR_CODE_UNKNOWN, "unimplemented"];
}

function decodersCmd(self, socket, args) {
  return [ERR_CODE_UNKNOWN, "unimplemented"];
}

function deleteCmd(self, socket, args) {
  return [ERR_CODE_UNKNOWN, "unimplemented"];
}

function deleteidCmd(self, socket, args) {
  return [ERR_CODE_UNKNOWN, "unimplemented"];
}

function disableoutputCmd(self, socket, args) {
  return [ERR_CODE_PERMISSION, "you don't have permission for \"disableoutput\""];
}

function enableoutputCmd(self, socket, args) {
  return [ERR_CODE_PERMISSION, "you don't have permission for \"disableoutput\""];
}

function findCmd(self, socket, args) {
  return [ERR_CODE_UNKNOWN, "unimplemented"];
}

function findaddCmd(self, socket, args) {
  return [ERR_CODE_UNKNOWN, "unimplemented"];
}

function killCmd(self, socket, args) {
  return [ERR_CODE_PERMISSION, "you don't have permission for \"kill\""];
}

function listCmd(self, socket, args) {
  return [ERR_CODE_UNKNOWN, "unimplemented"];
}

function listallCmd(self, socket, args) {
  return [ERR_CODE_UNKNOWN, "unimplemented"];
}


function listallinfoCmd(self, socket, args) {
  var trackTable = self.gb.player.libraryIndex.trackTable;
  for (var key in trackTable) {
    var dbTrack = trackTable[key];
    writeTrackInfo(socket, dbTrack);
  }
}

function listplaylistCmd(self, socket, args) {
  return [ERR_CODE_UNKNOWN, "unimplemented"];
}

function listplaylistinfoCmd(self, socket, args) {
  return [ERR_CODE_UNKNOWN, "unimplemented"];
}

function listplaylistsCmd(self, socket, args) {
  return [ERR_CODE_UNKNOWN, "unimplemented"];
}

function loadCmd(self, socket, args) {
  return [ERR_CODE_UNKNOWN, "unimplemented"];
}

function lsinfoCmd(self, socket, args) {
  return [ERR_CODE_UNKNOWN, "unimplemented"];
}

function mixrampdbCmd(self, socket, args) {
  return [ERR_CODE_UNKNOWN, "unimplemented"];
}

function mixrampdelayCmd(self, socket, args) {
  return [ERR_CODE_UNKNOWN, "unimplemented"];
}

function moveCmd(self, socket, args) {
  return [ERR_CODE_UNKNOWN, "unimplemented"];
}

function moveidCmd(self, socket, args) {
  return [ERR_CODE_UNKNOWN, "unimplemented"];
}

function nextCmd(self, socket, args) {
  self.gb.player.next();
}

function notcommandsCmd(self, socket, args) {
  return [ERR_CODE_UNKNOWN, "unimplemented"];
}

function outputsCmd(self, socket, args) {
  return [ERR_CODE_UNKNOWN, "unimplemented"];
}

function passwordCmd(self, socket, args) {
  return [ERR_CODE_UNKNOWN, "unimplemented"];
}

function pauseCmd(self, socket, args) {
  if (args.length > 1) {
    return [ERR_CODE_ARG, "too many arguments for \"pause\""];
  } else if (args.length === 1) {
    var pause = parseBool(args[0]);
    if (pause) {
      self.gb.player.pause();
    } else {
      self.gb.player.play();
    }
  } else {
    // toggle
    if (self.gb.player.isPlaying) {
      self.gb.player.pause();
    } else {
      self.gb.player.play();
    }
  }
}

function pingCmd(self, socket, args) {
  // nothing to do
}

function playCmd(self, socket, args) {
  var index = 0;

  if (args.length > 1) {
    return [ERR_CODE_ARG, "too many arguments for \"play\""];
  } else if (args.length === 1) {
    index = parseInt(args[0], 10);
    if (isNaN(index)) return [ERR_CODE_ARG, "Integer expected: " + args[0]];
  }

  self.gb.player.seekToIndex(index, 0);
}

function playidCmd(self, socket, args) {
  var id = self.gb.player.tracksInOrder[0].id;

  if (args.length > 1) {
    return [ERR_CODE_ARG, "too many arguments for \"playid\""];
  } else if (args.length === 1) {
    id = args[0];
    var item = self.gb.player.playlist[id];
    if (!item) return [ERR_CODE_NO_EXIST, "No such song"];
  }

  self.gb.player.seek(id, 0);
}

function playlistCmd(self, socket, args) {
  var trackTable = self.gb.player.libraryIndex.trackTable;
  self.gb.player.tracksInOrder.forEach(function(track, index) {
    var dbTrack = trackTable[track.key];
    socket.write(index + ":file: " + dbTrack.file + "\n");
  });
}

function playlistaddCmd(self, socket, args) {
  return [ERR_CODE_UNKNOWN, "unimplemented"];
}

function playlistclearCmd(self, socket, args) {
  return [ERR_CODE_UNKNOWN, "unimplemented"];
}

function playlistdeleteCmd(self, socket, args) {
  return [ERR_CODE_UNKNOWN, "unimplemented"];
}

function playlistfindCmd(self, socket, args) {
  return [ERR_CODE_UNKNOWN, "unimplemented"];
}

function playlistidCmd(self, socket, args) {
  return [ERR_CODE_UNKNOWN, "unimplemented"];
}

function playlistinfoCmd(self, socket, args) {
  var start = 0;
  var end = self.gb.player.tracksInOrder.length;

  if (args.length > 1) {
    return [ERR_CODE_ARG, "too many arguments for \"playlistinfo\""];
  } else if (args.length === 1) {
    var parts = args[0].split(":");
    if (parts.length > 2) {
      return [ERR_CODE_ARG, "Integer or range expected: " + args[0]];
    } else if (parts.length === 2) {
      start = parseInt(parts[0], 10);
      end = parseInt(parts[1], 10);
    } else {
      start = parseInt(parts[0], 10);
      end = start + 1;
    }
  }
  if (isNaN(start) || isNaN(end)) {
    return [ERR_CODE_ARG, "Integer or range expected: " + args[0]];
  }
  var trackTable = self.gb.player.libraryIndex.trackTable;
  for (var i = start; i < end; i += 1) {
    var item = self.gb.player.tracksInOrder[i];
    var track = trackTable[item.key];
    writeTrackInfo(socket, track);
    socket.write("Pos: " + i + "\n");
    socket.write("Id: " + item.id + "\n");
  }
}

function playlistmoveCmd(self, socket, args) {
  return [ERR_CODE_UNKNOWN, "unimplemented"];
}

function playlistsearchCmd(self, socket, args) {
  return [ERR_CODE_UNKNOWN, "unimplemented"];
}

function plchangesCmd(self, socket, args) {
  return [ERR_CODE_UNKNOWN, "unimplemented"];
}

function plchangesposidCmd(self, socket, args) {
  return [ERR_CODE_UNKNOWN, "unimplemented"];
}

function previousCmd(self, socket, args) {
  self.gb.player.prev();
}

function prioCmd(self, socket, args) {
  return [ERR_CODE_UNKNOWN, "unimplemented"];
}

function prioidCmd(self, socket, args) {
  return [ERR_CODE_UNKNOWN, "unimplemented"];
}

function randomCmd(self, socket, args) {
  return [ERR_CODE_UNKNOWN, "unimplemented"];
}

function readmessagesCmd(self, socket, args) {
  return [ERR_CODE_UNKNOWN, "unimplemented"];
}

function renameCmd(self, socket, args) {
  return [ERR_CODE_UNKNOWN, "unimplemented"];
}

function repeatCmd(self, socket, args) {
  return [ERR_CODE_UNKNOWN, "unimplemented"];
}

function replay_gain_modeCmd(self, socket, args) {
  return [ERR_CODE_UNKNOWN, "unimplemented"];
}

function replay_gain_statusCmd(self, socket, args) {
  return [ERR_CODE_UNKNOWN, "unimplemented"];
}

function rescanCmd(self, socket, args) {
  socket.write("updating_db: 1\n");
}

function rmCmd(self, socket, args) {
  return [ERR_CODE_UNKNOWN, "unimplemented"];
}

function saveCmd(self, socket, args) {
  return [ERR_CODE_UNKNOWN, "unimplemented"];
}

function searchCmd(self, socket, args) {
  return [ERR_CODE_UNKNOWN, "unimplemented"];
}

function searchaddCmd(self, socket, args) {
  return [ERR_CODE_UNKNOWN, "unimplemented"];
}

function searchaddplCmd(self, socket, args) {
  return [ERR_CODE_UNKNOWN, "unimplemented"];
}

function seekCmd(self, socket, args) {
  if (args.length !== 2) {
    return [ERR_CODE_ARG, "wrong number of arguments for \"seek\""];
  }
  var index = parseInt(args[0], 10);
  if (isNaN(index)) return [ERR_CODE_ARG, "Integer expected: " + args[0]];

  // we secretly accept floats, but to match mpd's output we still give
  // the "Integer expected" response.
  var pos = parseFloat(args[1]);
  if (isNaN(pos)) return [ERR_CODE_ARG, "Integer expected: " + args[0]];

  self.gb.player.seekToIndex(index, pos);
}

function seekcurCmd(self, socket, args) {
  if (args.length !== 1) {
    return [ERR_CODE_ARG, "wrong number of arguments for \"seek\""];
  }

  var pos = parseFloat(args[0]);
  if (isNaN(pos)) return [ERR_CODE_ARG, "Integer expected: " + args[0]];

  var currentTrack = self.gb.player.currentTrack;
  if (!currentTrack) return [ERR_CODE_PLAYER_SYNC, "Not playing"];

  var curId = currentTrack.id;
  self.gb.player.seek(curId, pos);
}

function seekidCmd(self, socket, args) {
  if (args.length !== 2) {
    return [ERR_CODE_ARG, "wrong number of arguments for \"seekid\""];
  }

  var id = args[0];

  // we secretly accept floats, but to match mpd's output we still give
  // the "Integer expected" response.
  var pos = parseFloat(args[1]);
  if (isNaN(pos)) return [ERR_CODE_ARG, "Integer expected: " + args[0]];

  self.gb.player.seek(id, pos);
}

function sendmessageCmd(self, socket, args) {
  return [ERR_CODE_UNKNOWN, "unimplemented"];
}

function setvolCmd(self, socket, args) {
  if (args.length !== 1) {
    return [ERR_CODE_ARG, "wrong number of arguments for \"setvol\""];
  }
  var vol100 = parseFloat(args[0]);
  if (isNaN(vol100)) return [ERR_CODE_ARG, "Integer expected: " + args[0]];

  self.gb.player.setVolume(vol100 / 100);
}

function shuffleCmd(self, socket, args) {
  self.gb.player.shufflePlaylist();
}

function singleCmd(self, socket, args) {
  switch (self.gb.player.repeat) {
    case Player.REPEAT_ONE:
      self.gb.player.setRepeat(Player.REPEAT_ALL);
      self.singleMode = false;
      break;
    case Player.REPEAT_ALL:
      self.gb.player.setRepeat(Player.REPEAT_ONE);
      self.singleMode = true;
      break;
    case Player.REPEAT_OFF:
      self.singleMode = !self.singleMode;
      break;
  }
}

function statsCmd(self, socket, args) {
  var uptime = Math.floor((new Date() - self.bootTime) / 1000);

  var libraryIndex = self.gb.player.libraryIndex;
  var artists = libraryIndex.artistList.length;
  var albums = libraryIndex.albumList.length;
  var songs = 0;
  var trackTable = libraryIndex.trackTable;
  var dbPlaytime = 0;
  for (var key in trackTable) {
    var dbTrack = trackTable[key];
    songs += 1;
    dbPlaytime += dbTrack.duration;
  }
  dbPlaytime = Math.floor(dbPlaytime);
  var dbUpdate = Math.floor(new Date().getTime() / 1000);
  socket.write("artists: " + artists + "\n");
  socket.write("albums: " + albums + "\n");
  socket.write("songs: " + songs + "\n");
  socket.write("uptime: " + uptime + "\n");
  socket.write("playtime: 0\n"); // TODO keep track of this?
  socket.write("db_playtime: " + dbPlaytime + "\n");
  socket.write("db_update: " + dbUpdate + "\n");
}

function statusCmd(self, socket, args) {
  var volume = Math.round(self.gb.player.volume * 100);

  var repeat, single;
  switch (self.gb.player.repeat) {
    case Player.REPEAT_ONE:
      repeat = 1;
      single = 1;
      break;
    case Player.REPEAT_ALL:
      repeat = 1;
      single = 0;
      break;
    case Player.REPEAT_OFF:
      repeat = 0;
      single = +self.singleMode;
      break;
  }
  var playlistLength = self.gb.player.tracksInOrder.length;
  var currentTrack = self.gb.player.currentTrack;
  var state;
  if (self.gb.player.isPlaying) {
    state = 'play';
  } else if (currentTrack) {
    state = 'pause';
  } else {
    state = 'stop';
  }

  var song = null;
  var songId = null;
  var nextSong = null;
  var nextSongId = null;
  var elapsed = null;
  var time = null;
  var trackTable = self.gb.player.libraryIndex.trackTable;
  if (currentTrack) {
    song = currentTrack.index;
    songId = currentTrack.id;
    var nextTrack = self.gb.player.tracksInOrder[currentTrack.index + 1];
    if (nextTrack) {
      nextSong = nextTrack.index;
      nextSongId = nextTrack.id;
    }

    var dbTrack = trackTable[currentTrack.key];
    elapsed = self.gb.player.getCurPos();
    time = Math.round(elapsed) + ":" + Math.round(dbTrack.duration);
  }


  socket.write("volume: " + volume + "\n");
  socket.write("repeat: " + repeat + "\n");
  socket.write("random: 0\n");
  socket.write("single: " + single + "\n");
  socket.write("consume: 0\n");
  socket.write("playlist: 0\n"); // TODO what to do with this?
  socket.write("playlistlength: " + playlistLength + "\n");
  socket.write("xfade: 0\n");
  socket.write("mixrampdb: 0.000000\n");
  socket.write("mixrampdelay: nan\n");
  socket.write("state: " + state + "\n");
  if (song != null) {
    socket.write("song: " + song + "\n");
    socket.write("songid: " + songId + "\n");
    if (nextSong != null) {
      socket.write("nextsong: " + nextSong + "\n");
      socket.write("nextsongid: " + nextSongId + "\n");
    }
    socket.write("time: " + time + "\n");
    socket.write("elapsed: " + elapsed + "\n");
    socket.write("bitrate: 192\n"); // TODO make this not hardcoded?
    socket.write("audio: 44100:24:2\n"); // TODO make this not hardcoded?
  }
}

function stickerCmd(self, socket, args) {
  return [ERR_CODE_UNKNOWN, "unimplemented"];
}

function stopCmd(self, socket, args) {
  self.gb.player.stop();
}

function subscribeCmd(self, socket, args) {
  return [ERR_CODE_UNKNOWN, "unimplemented"];
}

function swapCmd(self, socket, args) {
  return [ERR_CODE_UNKNOWN, "unimplemented"];
}

function swapidCmd(self, socket, args) {
  return [ERR_CODE_UNKNOWN, "unimplemented"];
}

function tagtypesCmd(self, socket, args) {
  return [ERR_CODE_UNKNOWN, "unimplemented"];
}

function unsubscribeCmd(self, socket, args) {
  return [ERR_CODE_UNKNOWN, "unimplemented"];
}

function updateCmd(self, socket, args) {
  return [ERR_CODE_UNKNOWN, "unimplemented"];
}

function urlhandlersCmd(self, socket, args) {
  return [ERR_CODE_UNKNOWN, "unimplemented"];
}