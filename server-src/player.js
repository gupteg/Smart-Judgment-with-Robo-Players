'use strict';

/**
 * RoboPlayer — the AI brain for one robo seat.
 *
 * Only the server holds these instances (server.js's roboInstances Map); they
 * are never serialised into gameState (which must stay plain JSON for
 * socket.io). Only { isRobo:true, difficulty:'Expert' } goes into
 * gameState.players[].
 *
 * PHASE 1: the robo's private state is now a two-part `brain`:
 *     brain.memory — CardMemory: cards played, revealed voids
 *     brain.round  — RoundContext: bid ledger, trick winners, deal facts
 * Both reset together at the start of every round. Phase 2 adds
 * brain.opponents (hand inference) here without any signature change.
 *
 * `lastTrace` holds the reasoning object from the most recent decision, which
 * server.js forwards to the host's debug panel (M2). Strategies stay stateless
 * — they return the trace, RoboPlayer is what remembers it.
 */

const { StrategyFactory } = require('./strategy');

class RoboPlayer {
    /**
     * @param {string} playerId
     * @param {string} name
     * @param {string} difficulty - 'Standard'|'Expert'
     */
    constructor(playerId, name, difficulty = 'Standard') {
        this.playerId   = playerId;
        this.name       = name;
        this.difficulty = difficulty;
        this.isRobo     = true;
        this.strategy   = StrategyFactory.create(difficulty);

        this.brain = {
            memory: StrategyFactory.createMemory(difficulty),
            round:  StrategyFactory.createRoundContext(difficulty, playerId),
        };

        this.lastTrace = null;
    }

    /** Convenience accessor — several call sites still refer to .memory. */
    get memory() { return this.brain.memory; }
    get round()  { return this.brain.round; }

    /**
     * Ask the robo for its bid this round.
     * @param {object} gs
     * @param {number} playerIndex
     * @param {object} context - { isLastBidder }
     * @returns {Promise<number>}
     */
    async makeBid(gs, playerIndex, context) {
        const result = await this.strategy.selectBid(gs, playerIndex, this.brain, context);
        this.lastTrace = result.trace || null;
        return result.bid;
    }

    /**
     * Ask the robo for its next card play.
     * @param {object} gs
     * @param {number} playerIndex
     * @param {object} context - { tricksPlayedSoFar, tricksRemaining, playersYetToAct }
     * @returns {Promise<{suit:string, rank:string}>}
     */
    async makeMove(gs, playerIndex, context) {
        const result = await this.strategy.selectCard(gs, playerIndex, this.brain, context);
        this.lastTrace = result.trace || null;
        return result.card;
    }

    // ── Observation hooks, called by server.js for every player's action ──

    /** A card was played to the current trick by ANY player. */
    recordCard(card, playerId) {
        this.brain.memory.recordCard(card, playerId);
    }

    /** A player failed to follow suit, revealing a void. */
    recordVoid(playerId, suit) {
        this.brain.memory.recordVoid(playerId, suit);
    }

    /** A bid was placed by ANY player (order matters — see B11). */
    recordBid(playerId, bid) {
        this.brain.round.recordBid(playerId, bid);
    }

    /** Bidding has finished; the table's over/under regime is now locked in. */
    markBiddingComplete() {
        this.brain.round.markBiddingComplete();
    }

    /** A trick completed and was won by playerId. */
    recordTrickWinner(playerId) {
        this.brain.round.recordTrickWinner(playerId);
    }

    /**
     * Start-of-round reset. Seeds this round's deal facts at the same time.
     * @param {object} deal - { handSize, trumpSuit, playerOrder, dealerId }
     */
    resetRound(deal = {}) {
        this.brain.memory.reset();
        this.brain.round.reset(deal);
        this.brain.round.myPlayerId = this.playerId;
        this.lastTrace = null;
    }

    /** Backwards-compatible alias for the original API. */
    resetMemory(deal = {}) {
        this.resetRound(deal);
    }
}

module.exports = { RoboPlayer };
