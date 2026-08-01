'use strict';

/**
 * RoboPlayer — encapsulates the AI brain for one robo seat.
 *
 * Only the server holds these instances (in server.js's roboInstances Map);
 * they are never sent to clients. The game engine interacts exclusively
 * through makeBid(), makeMove(), recordCard(), recordVoid(), resetMemory().
 *
 * IMPORTANT: RoboPlayer instances are NOT serialised into gameState (which
 * must remain plain JSON for socket.io to broadcast it). Only the
 * lightweight flags { isRobo:true, difficulty:'Expert' } live in
 * gameState.players[].
 */

const { StrategyFactory } = require('./strategy');

class RoboPlayer {
    /**
     * @param {string} playerId  - Unique ID (stored in gameState too)
     * @param {string} name      - Display name
     * @param {string} difficulty - 'Standard'|'Expert'
     */
    constructor(playerId, name, difficulty = 'Standard') {
        this.playerId   = playerId;
        this.name       = name;
        this.difficulty = difficulty;
        this.isRobo     = true;
        this.strategy   = StrategyFactory.create(difficulty);
        this.memory     = StrategyFactory.createMemory(difficulty);
    }

    /**
     * Ask the robo for its bid this round.
     * @param {object} gs           - Current game state (read-only from robo's POV)
     * @param {number} playerIndex  - Robo's index in gs.players
     * @param {object} context      - { isLastBidder }
     * @returns {Promise<number>}
     */
    async makeBid(gs, playerIndex, context) {
        return this.strategy.selectBid(gs, playerIndex, this.memory, context);
    }

    /**
     * Ask the robo for its next card play.
     * @param {object} gs
     * @param {number} playerIndex
     * @param {object} context      - { tricksPlayedSoFar, tricksRemaining }
     * @returns {Promise<{suit:string, rank:string}>}
     */
    async makeMove(gs, playerIndex, context) {
        return this.strategy.selectCard(gs, playerIndex, this.memory, context);
    }

    /**
     * Record a card played to the current trick (by ANY player, including
     * this robo itself). Called by the game engine after every successful play.
     * @param {{suit:string,rank:string}} card
     * @param {string} playerId
     */
    recordCard(card, playerId) {
        this.memory.recordCard(card, playerId);
    }

    /**
     * Record that a player revealed a void in a suit (didn't follow suit
     * when required to).
     * @param {string} playerId
     * @param {string} suit
     */
    recordVoid(playerId, suit) {
        this.memory.recordVoid(playerId, suit);
    }

    /** Reset memory at the start of a new round (new hand, new trump). */
    resetMemory() {
        this.memory.reset();
    }
}

module.exports = { RoboPlayer };
