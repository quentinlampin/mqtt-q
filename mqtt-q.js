/**
 * MQTT client wrapped with Q promises
 * author: Quentin Lampin <quentin.lampin@gmail.com>
 * license: MPL-2.0
 */
var mqtt = require('mqtt'),
    Q = require('q'),
    debug = require('debug')('mqtt-q');

/**
 * MQTT client states
 * @type {{NOT_CONFIGURED: string, CONFIGURED: string, RUNNING: string, HALTED: string, BUSY: string, ERROR: string}}
 */
var STATE = {
    NOT_CONFIGURED: 'not configured',
    CONFIGURED: 'configured',
    RUNNING: 'running',
    HALTED: 'halted',
    BUSY: 'busy',
    ERROR: 'error'
};

/**
 * MQTT connection states
 * @type {{ONLINE: string, OFFLINE: string}}
 */
var CONNECTION = {
    ONLINE: 'online',
    OFFLINE: 'offline'
};

/**
 * MQTT connection events
 * @type {{OFFLINE: string, RECONNECT: string, MESSAGE: string}}
 */
var EVENT = {
    OFFLINE: 'offline',
    RECONNECT: 'reconnect',
    MESSAGE: 'message'
};

/**
 * MQTT QOS types
 * @type {{BEST_EFFORT: number, GUARANTEED_DELIVERY: number, GUARANTEED_UNIQUE_DELIVERY: number}}
 */
var QOS = {
    BEST_EFFORT: 0,
    GUARANTEED_DELIVERY: 1,
    GUARANTEED_UNIQUE_DELIVERY: 2
};

/**
 * MQTT-Q Errors
 * @type {{CONFIGURATION: number, COMMAND: number, CONNECTION: number, SUBSCRIPTION: number}}
 */
var ERROR = {
    CONFIGURATION: 0,
    COMMAND: 1,
    CONNECTION: 2,
    SUBSCRIPTION: 3
};

/**
 * base class error for mqtt-q
 * @param {Number} code - error code (unsigned integer)
 * @param {String} message - explanation of the exception
 * @param {*} content - error passed by the MQTT library
 * @constructor
 */
function Error(code, message, content){
    this.code = code;
    this.message = message;
    this.content = content;
    return this;
}

/**
 * Occurs when a forbidden command is passed to the MqttQClient
 * @param command
 * @param state
 * @returns {CommandForbiddenError}
 * @constructor
 */
function CommandForbiddenError(command, state){
    Error.apply(this,
        [ERROR.COMMAND, 'command: ' + command + ' forbidden in state: ' + state]
    );
    return this;
}

/**
 * Occurs when the QOS argument has an unknown value
 * @param qos
 * @returns {UnknownQOSError}
 * @constructor
 */
function UnknownQOSError(qos) {
    Error.apply(this,
        [ERROR.CONFIGURATION, 'unknown QOS value: '+ qos]
    );
    return this;
}

/**
 * Occurs when the event is unknown
 * @param event
 * @returns {UnknownEvent}
 * @constructor
 */
function UnknownEvent(event) {
    Error.apply(this,
        [ERROR.CONFIGURATION, 'unknown event: '+ event]
    );
    return this;
}

/**
 * MQTT connection error
 * @param configuration
 * @param {*} error - error passed by the MQTT library
 * @constructor
 */
function ConnectionError(configuration, error){
    Error.apply(this,
        [ERROR.CONNECTION, 'could not connect to ' + configuration.host + ':' + configuration.port, error]
    );
    return this;
}

/**
 *
 * @param {*} configuration - topic subscriptions
 * @param {*} error - error passed by the MQTT library
 * @constructor
 */
function SubscriptionError(configuration, error){
    Error.apply(this,
        [ERROR.SUBSCRIPTION, 'could not subscribe to ' + configuration, error]
    );
    return this;
}

function UnknownSubscriptionError(topic) {
    Error.apply(this,
        [ERROR.SUBSCRIPTION, 'unknown subscription: ' + topic]
    );
    return this;
}

/**
 * MQTT Client with promise
 * @param clientId
 * @param host
 * @param port
 * @param options
 * @returns {MqttClientQ}
 * @constructor
 */
function MqttClientQ(clientId, host, port, options){
    this.clientId = clientId;
    this.host = host;
    this.port = port;
    this.options = options;
    this.state = STATE.CONFIGURED;
    this.connection = CONNECTION.OFFLINE;
    this.subscriptions = {};
    this.inner_ = undefined;
    this.callbacks = {};
    this.callbacks[EVENT.OFFLINE] = undefined;
    this.callbacks[EVENT.RECONNECT] = undefined;
    this.callbacks[EVENT.MESSAGE] = undefined;
    debug('mqtt client created with host target: ' + host + ':' + port);
    return this;
}

/**
 * Status of the MQTT client
 * @returns {{id: {String}, host: {String}, port: {Number}, state: {String}, connection: {String}, subscriptions: Array}}
 */
MqttClientQ.prototype.status = function(){
    return {
        id: this.clientId,
        host: this.host,
        port: this.port,
        state: this.state,
        connection: this.connection,
        subscriptions: Object.keys(this.subscriptions)
    }
};

/**
 * Resolve promise and update the MqttQClient state
 * @param deferred
 * @param state
 * @param connection
 * @private
 */
MqttClientQ.prototype.resolvePromise_ = function(deferred, state, connection){
    this.state = state;
    if(connection){
        this.connection = connection;
    }
    if(deferred){
        deferred.resolve(this);
    }

};

/**
 * Reject promise and put the MqttQClient in error state
 * @param deferred
 * @param {Error} error - error
 * @private
 */
MqttClientQ.prototype.rejectPromise_ = function(deferred, error){
    this.state = STATE.ERROR;
    if(deferred){
        deferred.reject(error);
    }

};

/**
 * called when the MQTT client is connected
 * @param deferred
 */
MqttClientQ.prototype.onConnect = function(deferred){
    var promises;

    debug('mqtt client is connected to: ' + this.host + ':' + this.port);
    this.connection = CONNECTION.ONLINE;
    this.state = STATE.RUNNING;
    promises = [];
    Object.keys(this.subscriptions).forEach(function(subscription){
        promises.push(this.subscribe(subscription, this.subscriptions[subscription]));
    }.bind(this));
    Q.all(promises).then(
        this.resolvePromise_.bind(this, deferred, STATE.RUNNING, CONNECTION.ONLINE),
        this.rejectPromise_.bind(this, deferred)
    )
};

/**
 * called when the MQTT client goes offline
 */
MqttClientQ.prototype.onOffline = function(){
    debug('mqtt client is offline');
    this.connection = CONNECTION.OFFLINE;
    if(this.callbacks[EVENT.OFFLINE]){
        this.callbacks[EVENT.OFFLINE]();
    }
};

/**
 * called when the MQTT client reconnects
 */
MqttClientQ.prototype.onReconnect = function(){
    debug('mqtt client attempts a reconnection');
    if(this.callbacks[EVENT.RECONNECT]){
        this.callbacks[EVENT.RECONNECT]();
    }
};

MqttClientQ.prototype.onSubscription = function(deferred, configuration, error, granted){
    if(error){
        this.rejectPromise_(deferred, new SubscriptionError(configuration, error));
    }else{
        granted.forEach(function(subscription){
            debug('mqtt client has subscribed to: ' + subscription.topic + '(' + subscription.qos + ')');
            this.subscriptions[String(subscription.topic)] = subscription.qos;
        }.bind(this));
        this.resolvePromise_(deferred, STATE.RUNNING);
    }
};

MqttClientQ.prototype.onUnsubscription = function(deferred, topic){
        debug('mqtt client has unsubscribed from: ' + topic);
        this.resolvePromise_(deferred, STATE.RUNNING);
};

/**
 * called when the MQTT client receives a message
 * @param topic - topic of the received message
 * @param {String|Buffer} message - received message
 */
MqttClientQ.prototype.onMessage = function(topic, message){
    debug('mqtt client received a message from topic: ' + topic + ' message: ' + message);
    if(this.callbacks[EVENT.MESSAGE]){
        this.callbacks[EVENT.MESSAGE](topic, message);
    }
};

MqttClientQ.prototype.onEnd = function (deferred) {
    debug('mqtt client has ended');
    this.subscriptions = {};
    this.resolvePromise_(deferred, STATE.HALTED, CONNECTION.OFFLINE);
};

/**
 * Connect to the MQTT broker
 * @returns {Promise}
 */
MqttClientQ.prototype.connect = function(){
    var deferred,
        configuration;

    debug('mqtt client attempts to connect');
    deferred = Q.defer();

    switch(this.state){
        case STATE.NOT_CONFIGURED:
        case STATE.RUNNING:
        case STATE.BUSY:
        case STATE.ERROR:
            this.rejectPromise_.bind(this, deferred, new CommandForbiddenError('connect', this.state));
            return deferred.promise;
            break;
    }

    configuration = {
        clientId: this.clientId,
        host: this.host,
        port: this.port
    };
    
    if(this.options){
        Object.keys(this.options).forEach(function(option){
            configuration[option] = this.options[option]
        }.bind(this));
    }

    this.state = STATE.BUSY;

    this.inner_ = mqtt.connect(configuration)
        .on('connect', this.onConnect.bind(this, deferred))
        .on('error', this.rejectPromise_.bind(this, deferred, new ConnectionError(configuration)))
        .on('offline', this.onOffline.bind(this))
        .on('reconnect',this.onReconnect.bind(this))
        .on('message', this.onMessage.bind(this));
    return deferred.promise;
};

/**
 * End the connection to the MQTT Broker
 * @param {boolean} force - force the end of the MQTT client activity
 * @returns {Promise}
 */
MqttClientQ.prototype.end = function(force){
    var deferred;

    deferred = Q.defer();
    switch(this.state){
        case STATE.NOT_CONFIGURED:
        case STATE.CONFIGURED:
        case STATE.HALTED:
        case STATE.BUSY:
        case STATE.ERROR:
            this.rejectPromise_.bind(this, deferred, new CommandForbiddenError('end', this.state));
            return deferred.promise;
            break;
    }
    this.state = STATE.BUSY;
    this.inner_.end(force, this.onEnd.bind(this, deferred, STATE.HALTED, CONNECTION.OFFLINE));
    return deferred.promise;
};

/**
 * Subscribes to given topic
 * @param {String} topic - topic to be subscribed
 * @param {Number} qos - desired QOS
 * @returns {Promise}
 */
MqttClientQ.prototype.subscribe = function (topic, qos) {
    var deferred,
        configuration;

    debug('mqtt client attempts to subscribe to topic: ' + topic + '(' + qos + ')');
    deferred = Q.defer();

    switch(this.state){
        case STATE.NOT_CONFIGURED:
        case STATE.CONFIGURED:
        case STATE.BUSY:
        case STATE.ERROR:
            this.rejectPromise_.bind(this, deferred, new CommandForbiddenError('subscribe', this.state));
            return deferred.promise;
            break;
    }

    configuration = {};
    configuration[topic] = qos;

    this.state = STATE.BUSY;

    switch(qos){
        case QOS.BEST_EFFORT:
        case QOS.GUARANTEED_DELIVERY:
        case QOS.GUARANTEED_UNIQUE_DELIVERY:
            break;
        default:
            this.rejectPromise_.bind(this, deferred, new UnknownQOSError(qos));
            return deferred.promise;
    }

    this.inner_.subscribe(configuration, this.onSubscription.bind(this, deferred, configuration));
    return deferred.promise;
};

MqttClientQ.prototype.unsubscribe = function (topic) {
    var deferred;

    debug('mqtt client attempts to unsubscribe from topic: ' + topic);
    deferred = Q.defer();

    switch(this.state){
        case STATE.NOT_CONFIGURED:
        case STATE.CONFIGURED:
        case STATE.BUSY:
        case STATE.ERROR:
            debug('unsubscribe error: incompatible state: ' + this.state);
            this.rejectPromise_.bind(this, deferred, new CommandForbiddenError('unsubscribe', this.state));
            return deferred.promise;
            break;
    }

    if(!this.subscriptions[topic]){
        debug('unsubscribe error, unknown topic: ' + topic);
        this.rejectPromise_.bind(this, deferred, new UnknownSubscriptionError(topic));
        return deferred.promise;
    }
    this.inner_.unsubscribe(topic, this.onUnsubscription.bind(this, deferred, topic));
    return deferred.promise;

};


/**
 * Publish message in given topic
 * @param {String} topic - topic of the message
 * @param {Number} message - message content
 * @param {Object} options - publish options
 * @returns {*}
 */
MqttClientQ.prototype.publish = function(topic, message, options){
    var deferred;

    deferred = Q.defer();

    switch(this.state){
        case STATE.NOT_CONFIGURED:
        case STATE.CONFIGURED:
        case STATE.HALTED:
        case STATE.BUSY:
        case STATE.ERROR:
            this.rejectPromise_.bind(this, deferred, new CommandForbiddenError('publish', this.state));
            return deferred.promise;
            break;
    }
    this.inner_.publish(topic, message, options ? options : {},
        this.resolvePromise_.bind(this, deferred, STATE.HALTED)
    );

    return deferred.promise;
};

/**
 * Sets a callback for given event
 * @param {String} event - event type (message, offline, reconnect)
 * @param {function} callback - function to call on event
 * @returns {Promise}
 */
MqttClientQ.prototype.on = function(event, callback){
    var deferred;

    deferred = Q.defer();

    switch(this.state){
        case STATE.HALTED:
        case STATE.BUSY:
        case STATE.ERROR:
            this.rejectPromise_.bind(this, deferred, new CommandForbiddenError('on:'+event, this.state));
            return deferred.promise;
            break;
    }

    switch(event){
        case EVENT.MESSAGE:
        case EVENT.OFFLINE:
        case EVENT.RECONNECT:
            this.callbacks[event] = callback;
            this.resolvePromise_.bind(this, deferred, STATE.RUNNING);
            break;
        default:
            this.rejectPromise_.bind(this, deferred, new UnknownEvent(event));
            break;
    }
    return deferred.promise;
};

module.exports = {
    Client: MqttClientQ,
    state: STATE,
    connection: CONNECTION,
    event: EVENT,
    qos: QOS,
    error: ERROR
};
