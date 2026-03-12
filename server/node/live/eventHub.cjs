const { EventEmitter } = require('events');

class LiveEventHub {
    constructor() {
        this.emitter = new EventEmitter();
        this.emitter.setMaxListeners(0);
    }

    channelName(sessionKey) {
        return `session:${sessionKey || 'default'}`;
    }

    publish(sessionKey, event) {
        this.emitter.emit(this.channelName(sessionKey), event);
    }

    subscribe(sessionKey, listener) {
        const channel = this.channelName(sessionKey);
        this.emitter.on(channel, listener);
        return () => {
            this.emitter.off(channel, listener);
        };
    }
}

function writeSseEvent(res, eventName, payload) {
    if (eventName) {
        res.write(`event: ${eventName}\n`);
    }
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

module.exports = {
    LiveEventHub,
    writeSseEvent,
};
