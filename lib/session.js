'use strict';

var __DEV__ = process.env.NODE_ENV === 'development';

var _         = require('lodash');
var Slack     = require('node-slackr');
var request   = require('request');
var WebSocket = require('ws');
var Q         = require('q');

var Channel = require('./channel');
var Event   = require('./event');
var Message = require('./message');

var formatMessage = require('./util/format-message.js');

var sessions = {};

function log() {
  if (__DEV__) {
    console.log.apply(console.log, arguments);
  }
}

function Session(token, options) {
  if (!options && !_.isString(token)) {
    options = token;
    token = options.token;
  }

  options || (options = {});

  if (sessions[token]) {
    return sessions[token];
  }

  sessions[token] = this;

  var url = 'https://slack.com/api/rtm.start?token='+token;

  this.lastMessageId = 0;

  this.channels = [];

  this.messageHandlers = [];

  this._connectPromise = Q.defer();
  request.get(url, function(err, response, body) {
    if (err) {
      this._connectPromise.reject(err);
      throw('error:', err);
    }

    var data = JSON.parse(body);

    this.data = data;

    // Note that we could resolve here, but we don't, since 
    // we want the websocket to connect.
  }.bind(this));

  this._channelMessagePings = {};

  _.bindAll(this, 'gotMessage');

  if (options.webhookClient) {
    this.webhookClient = options.webhookClient;
  }

  if (options.imPrefix) {
    this.imPrefix = options.imPrefix;
  }

  if (options.devChannel) {
    this.devChannel = options.devChannel;

    if (__DEV__) {
      return this.channel(options.devChannel);
    }
  }
}

Session.prototype = {
  channel: function(name) {
    var channel = new Channel(this, name);

    this.channels.push(channel);

    return channel;
  },

  gotMessage: function(msg) {
    var data = JSON.parse(msg);

    log('message recieved: ', msg);

    if (this['_handleType_' + data.type]) {
      this['_handleType_' + data.type](data);
    }
  },

  _handleType_message: function(data) {
    if (data && data.subtype === 'bot_message') {
      return;
    }

    if (this.devChannel) {
      var channelId = this.channelOrImData(this.devChannel).id;

      var isDevChannel = data.channel === channelId;

      if (__DEV__ && !isDevChannel) {
        return;
      } else if (!__DEV__ && isDevChannel) {
        return;
      }
    }

    var msg = new Message(this, data);

    for (var i = this.messageHandlers.length - 1; i >= 0; i--) {
      this.messageHandlers[i].match(msg);
    }

    _.each(this._channelMessagePings[msg.channelId], function(cb) {
      cb(data);
    });
  },

  on: function(selector, callback) {
    if (callback) {
      this.messageHandlers.push(new Event(this, selector, callback));
    } else {
      for (var key in selector) {
        if (selector.hasOwnProperty(key)) {
          this.on(key, selector[key]);
        }
      }
    }
  },

  onChannelMessage: function(name, cb) {
    var data = this.channelData(name);

    if (!data) {
      console.error('Need to re-get channel list');
      return false;
    }

    this._channelMessagePings[data.id] || (this._channelMessagePings[data.id] = []);

    this._channelMessagePings[data.id].push(cb);
  },

  channelData: function(name) {
    var data;

    if (!this.data) {
      return;
    }

    if (name[0] === '#') {
      name = name.slice(1);

      data = _.find(this.data.channels, function(c) {
        return c.name === name;
      });
    } else if (name[0] === '@') {
      data = this.imDataForUser(name.slice(1));
    } else {
      data = _.find(this.data.channels, function(c) {
        return c.id === name;
      });
    }

    return data;
  },

  imDataForUser: function(name) {
    if (!this.data) {
      return;
    }

    var userId;

    if (name[0] === '@') {
      name = name.slice(1);

      userId = this.userId(name);
    } else {
      userId = name;
    }

    return userId && _.find(this.data.ims, {user: userId});
  },

  imData: function(id) {
    return _.find(this.data.ims, {id: id});
  },

  userId: function(name) {
    var data = this.userData('@' + name);
    return data && data.id;
  },

  userData: function(name) {
    var data;

    if (!this.data) {
      return;
    }

    if (name[0] === '@') {
      name = name.slice(1);

      data = _.find(this.data.users, function(c) {
        return c.name === name;
      });
    } else {
      data = _.find(this.data.users, function(c) {
        return c.id === name;
      });
    }

    return data;
  },

  channelOrImData: function(name) {
    return this.channelData(name) || this.imData(name);
  },

  sendMessage: function(msg) {
    msg = formatMessage(msg);

    if (msg.channel) {
        // slack now expects an id for the channel, rather than a name
        var known = this.channelData(msg.channel);
        if (known) {
            msg.channel = known.id;
        }
    }

    if (msg.attachments && this.webhookClient) {
      this.webhookClient.notify(msg);

      log('message sent via client ', JSON.stringify(msg));
    } else {
      this.send(msg);

      log('message sent via websocket ', JSON.stringify(msg));
    }
  },

  send: function(msg) {
    this.lastMessageId += 1;
    msg.id = this.lastMessageId;
    var str = JSON.stringify(msg);
    this.ws.send(str);
  },

  get name() {
    if (this.data) {
      return this.data.self.name;
    }
  },

  get id() {
    if (this.data) {
      return this.data.self.id;
    }
  },

  get data() {
    return this._data;
  },

  set data(data) {
    this._data = data;

    _(this.channels).invoke('setChannels');

    this.ws = new WebSocket(data.url);

    this.ws.on('message', this.gotMessage);

    this.ws.on('open', function () {
        this._connectPromise.resolve(this);
    }.bind(this));
  },

  get webhookClient() {
    return this._webhookClient;
  },

  set webhookClient(client) {
    if (client instanceof Slack) {
      this._webhookClient = client;
    } else {
      var options = _.clone(client);
      var hook = options.webhookUrl;
      delete options.webhookUrl;
      
      this._webhookClient = new Slack(hook, options);
    }
  },

  get connected() {
    return this._connectPromise.promise;
  }
};

module.exports = Session;
