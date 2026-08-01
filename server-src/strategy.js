'use strict';

/**
 * Strategy — async interface for robo bidding and card-play decisions.
 *
 * Two tiers (design decision — no third tier; Phase 1 folds entirely into Expert):
 *
 *   StandardStrategy — FROZEN. Naive bid estimator, this-trick-only awareness,
 *                      no memory, no table-regime awareness. Deliberately the
 *                      weaker opponent; the gap between tiers is the product.
 *                      The only change made in Phase 1 is preserving its
 *                      original behaviour now that getPlayMode() emits a
 *                      fourth mode ('D') it never used to see.
 *
 *   ExpertStrategy   — rebuilt around a per-turn "situation" snapshot and a
 *                      four-way POSTURE (GRAB / SHED / BALANCE / SABOTAGE)
 *                      rather than the old three-mode card picker.
 *
 * SIGNATURE CHANGE (Phase 1):
 *     selectBid(gs, playerIndex, brain, context)
 *     selectCard(gs, playerIndex, brain, context)
 * where `brain = { memory, round }`. The bundle draws a real boundary:
 * `brain` is what this robo privately knows and has inferred; `gs` + `context`
 * is what the table publicly shows. Phase 2's opponent-inference layer becomes
 * `brain.opponents` without touching any signature.
 *
 * Both methods return an OBJECT, not a bare value:
 *     { bid, trace }   /   { card, trace }
 * The `trace` powers the host-only reasoning panel (M2). Strategies remain
 * completely stateless — the trace travels in the return value, and RoboPlayer
 * is what holds on to it.
 */

const { DecisionEngine, RANK_VALUES, NO_TRUMP, TUNING } = require('./decision-engine');

// ─────────────────────────────────────────────────────────────────────────
// BASE CLASS
// ─────────────────────────────────────────────────────────────────────────

class Strategy {
    /** @returns {Promise<{bid:number, trace:object}>} */
    async selectBid(gs, playerIndex, brain, context) {
        throw new Error(`${this.constructor.name}.selectBid() not implemented`);
    }

    /** @returns {Promise<{card:object, trace:object}>} */
    async selectCard(gs, playerIndex, brain, context) {
        throw new Error(`${this.constructor.name}.selectCard() not implemented`);
    }

    /** Sum of bids placed so far this round (nulls treated as 0). */
    _bidsSoFarSum(gs) {
        return gs.players.reduce((sum, p) => sum + (p.bid || 0), 0);
    }

    /** Individual bids placed so far, excluding players yet to bid. */
    _bidsSoFarArray(gs) {
        return gs.players.filter(p => p.bid !== null && p.bid !== undefined).map(p => p.bid);
    }

    _numActivePlayers(gs) {
        return gs.players.filter(p => p.status === 'Active').length;
    }
}

// ─────────────────────────────────────────────────────────────────────────
// STANDARD — frozen behaviour
// ─────────────────────────────────────────────────────────────────────────

class StandardStrategy extends Strategy {
    async selectBid(gs, playerIndex, brain, context) {
        const player = gs.players[playerIndex];
        const handSize = gs.numCardsToDeal;
        const raw = DecisionEngine.estimateBidStandard(player.hand, gs.trumpSuit, handSize);

        const forbidden = DecisionEngine.getForbiddenBid(
            this._bidsSoFarSum(gs), handSize, context.isLastBidder
        );
        const bid = DecisionEngine.resolveLegalBid(raw, handSize, forbidden);
        return {
            bid,
            trace: {
                tier: 'Standard',
                kind: 'bid',
                headline: `Naive estimate ${raw} → bid ${bid}`,
                lines: [
                    `Sum of naive per-card scores: ${raw}`,
                    forbidden !== null ? `Hook rule forbids ${forbidden}` : 'Not the last bidder',
                ],
            },
        };
    }

    async selectCard(gs, playerIndex, brain, context) {
        const player = gs.players[playerIndex];
        const legal = DecisionEngine.getLegalCards(player.hand, gs.leadSuit);
        if (legal.length === 1) {
            return { card: legal[0].card, trace: this._trace('Only one legal card', []) };
        }

        // Preserve the original three-mode behaviour now that getPlayMode()
        // also emits 'D'. Standard has no spoiler concept: a busted-high robo
        // still ducks, a busted-low robo still chases, exactly as before.
        const rawMode = DecisionEngine.getPlayMode(
            player.bid, player.tricksWon, gs.numCardsToDeal, context.tricksPlayedSoFar
        );
        const mode = rawMode === 'D'
            ? ((player.tricksWon || 0) > (player.bid || 0) ? 'B' : 'A')
            : rawMode;

        const trickSoFar = gs.currentTrick;
        const winningCards = DecisionEngine.getWinningCards(legal, trickSoFar, gs.trumpSuit);
        const nonWinning = legal.filter(c => !winningCards.includes(c));

        if (mode === 'A') {
            const best = DecisionEngine.highestCard(winningCards);
            const chosen = (best || DecisionEngine.highestCard(legal));
            return { card: chosen.card, trace: this._trace('Mode A — must win, play strongest', []) };
        }

        if (mode === 'B') {
            if (nonWinning.length > 0) {
                return { card: DecisionEngine.lowestCard(nonWinning).card, trace: this._trace('Mode B — duck low', []) };
            }
            return { card: DecisionEngine.lowestCard(winningCards).card, trace: this._trace('Mode B — forced to win', []) };
        }

        if (trickSoFar.length === 0) {
            const sorted = [...legal].sort((a, b) => RANK_VALUES[a.card.rank] - RANK_VALUES[b.card.rank]);
            return { card: sorted[Math.floor(sorted.length / 2)].card, trace: this._trace('Mode C — lead a medium card', []) };
        }
        if (winningCards.length > 0) {
            return { card: DecisionEngine.lowestCard(winningCards).card, trace: this._trace('Mode C — win cheaply', []) };
        }
        return {
            card: DecisionEngine.lowestCard(nonWinning.length > 0 ? nonWinning : legal).card,
            trace: this._trace('Mode C — cannot win, duck', []),
        };
    }

    _trace(headline, lines) {
        return { tier: 'Standard', kind: 'play', headline, lines };
    }
}

// ─────────────────────────────────────────────────────────────────────────
// EXPERT
// ─────────────────────────────────────────────────────────────────────────

class ExpertStrategy extends Strategy {

    // ═══════════════════════════════════════════════════════════════
    // BIDDING
    // ═══════════════════════════════════════════════════════════════

    async selectBid(gs, playerIndex, brain, context) {
        const { round } = brain;
        const player = gs.players[playerIndex];
        const handSize = gs.numCardsToDeal;
        const numActivePlayers = this._numActivePlayers(gs);

        // B11 — bids placed strictly before me, in order. Sourced from the
        // round ledger (which knows bidding ORDER) with a gameState fallback.
        const bidsBefore = round.bidSequence && round.bidSequence.length > 0
            ? round.bidSequence.map(e => e.bid)
            : this._bidsSoFarArray(gs);

        const bidsSum = bidsBefore.reduce((a, b) => a + b, 0);
        const forbidden = DecisionEngine.getForbiddenBid(bidsSum, handSize, context.isLastBidder);

        const detail = DecisionEngine.estimateBidExpertDetailed(player.hand, gs.trumpSuit, handSize, {
            numActivePlayers,
            bidsBefore,
            forbiddenBid: forbidden,
        });

        // bestBidByEV already skipped the forbidden value, but run the bid
        // through resolveLegalBid as a belt-and-braces guard (B13).
        const bid = DecisionEngine.resolveLegalBid(detail.bid, handSize, forbidden, {
            evTable: detail.table,
            surplusIfBidLow: handSize - bidsSum - detail.bid,
        });

        const top = [...detail.table].sort((a, b) => b.ev - a.ev).slice(0, 3);
        const lines = [
            `Raw trick expectation: ${detail.expected.toFixed(2)}`,
            `Per-card win odds: ${detail.probs
                .sort((a, b) => b.p - a.p)
                .slice(0, 6)
                .map(e => `${e.card.rank}${this._suitGlyph(e.card.suit)} ${(e.p * 100).toFixed(0)}%`)
                .join('  ')}`,
            `Best EV options: ${top.map(t => `bid ${t.bid} → EV ${t.ev.toFixed(2)} (P=${(t.p * 100).toFixed(0)}%)`).join('  |  ')}`,
        ];
        if (bidsBefore.length > 0) {
            const fair = handSize * (bidsBefore.length / Math.max(1, numActivePlayers));
            lines.push(`Prior bids total ${bidsSum} vs par ${fair.toFixed(1)} → ${bidsSum > fair ? 'shading DOWN' : 'shading up slightly'}`);
        }
        if (forbidden !== null) lines.push(`Hook rule forbids ${forbidden}`);

        return {
            bid,
            trace: {
                tier: 'Expert', kind: 'bid',
                headline: `Bid ${bid} (expected ${detail.expected.toFixed(1)} tricks)`,
                lines,
            },
        };
    }

    // ═══════════════════════════════════════════════════════════════
    // CARD PLAY
    // ═══════════════════════════════════════════════════════════════

    async selectCard(gs, playerIndex, brain, context) {
        const player = gs.players[playerIndex];
        const legal = DecisionEngine.getLegalCards(player.hand, gs.leadSuit);
        if (legal.length === 1) {
            const only = legal[0].card;
            return {
                card: only,
                trace: this._trace(
                    `Forced — ${only.rank} of ${only.suit}`,
                    null,
                    ['Only one legal card in hand; no decision to make.']
                ),
            };
        }

        const sit = DecisionEngine.buildSituation(gs, playerIndex, brain, context);

        let choice;
        switch (sit.posture) {
            case 'GRAB':     choice = this._playGrab(sit);     break;
            case 'SHED':     choice = this._playShed(sit);     break;
            case 'SABOTAGE': choice = this._playSabotage(sit); break;
            default:         choice = this._playBalance(sit);  break;
        }

        // Defensive: never return an illegal card.
        if (!choice || !choice.entry) {
            choice = { entry: DecisionEngine.lowestCard(sit.legal), why: 'fallback — lowest legal card' };
        }

        return {
            card: choice.entry.card,
            trace: this._buildPlayTrace(sit, choice),
        };
    }

    // ───────────────────────────────────────────────────────────────
    // POSTURE: GRAB — I need this trick
    // ───────────────────────────────────────────────────────────────

    _playGrab(sit) {
        if (sit.isLeading) return this._leadToWin(sit);

        const winners = DecisionEngine.getWinningCards(sit.legal, sit.trickSoFar, sit.trumpSuit);
        if (winners.length === 0) {
            // R5 — cannot win, so preserve everything of value.
            return { entry: DecisionEngine.cheapestByCost(sit.legal, sit.evalCtx), why: 'cannot win — keep winners, play cheapest' };
        }

        // R10 — a "winner" that three players still get to beat is not a winner.
        const scored = winners.map(w => ({
            entry: w,
            survival: DecisionEngine.survivalProbability(w.card, sit.evalCtx),
            cost: DecisionEngine.cardCost(w.card, sit.evalCtx),
        }));

        const safe = scored.filter(s => s.survival >= TUNING.SAFE_WIN_THRESHOLD)
                           .sort((a, b) => a.cost - b.cost);
        if (safe.length > 0) {
            return {
                entry: safe[0].entry,
                why: `cheapest winner that survives ${sit.playersYetToAct} player(s) to act (${(safe[0].survival * 100).toFixed(0)}% safe)`,
            };
        }

        const bestChance = scored.sort((a, b) => b.survival - a.survival || a.cost - b.cost)[0];
        if (bestChance.survival >= 0.40 || sit.mode === 'A') {
            return { entry: bestChance.entry, why: `best available shot at the trick (${(bestChance.survival * 100).toFixed(0)}%)` };
        }
        return { entry: DecisionEngine.cheapestByCost(sit.legal, sit.evalCtx), why: 'no winner likely to survive — save the card' };
    }

    _leadToWin(sit) {
        const myTrumps = sit.trumpSuit !== NO_TRUMP
            ? sit.legal.filter(c => c.card.suit === sit.trumpSuit)
            : [];

        // R12 — draw trumps when I hold more than the field does, so my
        // side-suit winners stop getting ruffed.
        if (myTrumps.length >= 2 && myTrumps.length >= sit.outstandingTrumps && sit.outstandingTrumps > 0.5) {
            const top = DecisionEngine.highestCard(myTrumps);
            return { entry: top, why: `drawing trumps (${myTrumps.length} held vs ~${sit.outstandingTrumps.toFixed(1)} out)` };
        }

        // L5 — cash the fastest-decaying winner first. Side-suit winners rot
        // as opponents become void; trump winners keep indefinitely.
        const bankableLegal = sit.legal.filter(l =>
            sit.bankable.some(b => b.card.suit === l.card.suit && b.card.rank === l.card.rank));

        const sideBankable = bankableLegal.filter(l => l.card.suit !== sit.trumpSuit);
        if (sideBankable.length > 0) {
            const pick = DecisionEngine.dearestByCost(sideBankable, sit.evalCtx);
            return { entry: pick, why: 'cashing a side-suit winner before it can be ruffed' };
        }
        if (bankableLegal.length > 0) {
            const pick = DecisionEngine.cheapestByCost(bankableLegal, sit.evalCtx);
            return { entry: pick, why: 'cashing cheapest banked winner' };
        }

        // No certain winner — lead my best chance.
        const best = sit.legal
            .map(l => ({ l, p: DecisionEngine.liveWinProbability(l.card, sit.evalCtx) }))
            .sort((a, b) => b.p - a.p)[0];
        return { entry: best.l, why: `no banked winner — leading best chance (${(best.p * 100).toFixed(0)}%)` };
    }

    // ───────────────────────────────────────────────────────────────
    // POSTURE: SHED — I must not win any more tricks
    // ───────────────────────────────────────────────────────────────

    _playShed(sit) {
        if (sit.isLeading) return this._leadToDuck(sit);

        const winners = DecisionEngine.getWinningCards(sit.legal, sit.trickSoFar, sit.trumpSuit);
        const losers = sit.legal.filter(l => !winners.includes(l));

        if (losers.length === 0) {
            // R6 — every legal card wins. I'm taking this trick regardless, so
            // burn my biggest card rather than my smallest. The old engine
            // played the LOWEST winner here, keeping the dangerous honour in
            // hand to be forced out on a later trick as well.
            return {
                entry: DecisionEngine.dearestByCost(sit.legal, sit.evalCtx),
                why: 'forced to win — burning my highest card so it cannot trap me later',
            };
        }

        const isDiscarding = sit.leadSuit && !sit.hand.some(c => c.suit === sit.leadSuit);
        if (isDiscarding) {
            // R7 / R3 — free discard. Throw the strongest surplus winner: it is
            // the card most certain to force a win later if kept.
            const surplusLegal = losers.filter(l =>
                sit.surplus.some(s => s.card.suit === l.card.suit && s.card.rank === l.card.rank));
            if (surplusLegal.length > 0) {
                const pick = this._byMaxDanger(surplusLegal, sit);
                return { entry: pick, why: 'discarding a surplus winner I no longer need' };
            }
            const pick = this._byMaxDanger(losers, sit);
            return { entry: pick, why: 'discarding my highest-danger card' };
        }

        // R4 — following suit under a winner I cannot beat: play my HIGHEST
        // losing card. Shedding the King under the Ace is the core skill here,
        // and the old engine did precisely the opposite.
        const pick = losers
            .map(l => ({ l, danger: DecisionEngine.dangerScore(l.card, sit.evalCtx), cost: DecisionEngine.cardCost(l.card, sit.evalCtx) }))
            .sort((a, b) => b.danger - a.danger || b.cost - a.cost)[0];
        return { entry: pick.l, why: 'safe high discard — losing anyway, so shed the dangerous card' };
    }

    _leadToDuck(sit) {
        // R13 — never lead a card that is currently top-outstanding.
        const bankableSet = new Set(sit.bankable.map(b => `${b.card.suit}-${b.card.rank}`));
        let candidates = sit.legal.filter(l => !bankableSet.has(`${l.card.suit}-${l.card.rank}`));

        // R12 — never lead trump when ducking; it just wins tricks.
        if (sit.trumpSuit !== NO_TRUMP) {
            const nonTrump = candidates.filter(l => l.card.suit !== sit.trumpSuit);
            if (nonTrump.length > 0) candidates = nonTrump;
        }

        if (candidates.length === 0) {
            // Everything I hold wins. Same logic as R6 — burn the biggest.
            return {
                entry: DecisionEngine.dearestByCost(sit.legal, sit.evalCtx),
                why: 'every card left is a winner — leading my biggest to burn it off',
            };
        }

        // S6 — don't hand a trick to somebody who still needs one if I can help
        // it. Avoid suits the top-value chaser is known void in (they'd ruff).
        const topChaser = sit.opponentStates.find(o => o.state === 'chasing');
        const scored = candidates.map(l => {
            const p = DecisionEngine.liveWinProbability(l.card, sit.evalCtx);
            let penalty = 0;
            if (topChaser && sit.outstandingTrumps > 0.5) {
                const memVoid = sit.evalCtx.memory.isKnownVoid
                    ? sit.evalCtx.memory.isKnownVoid(topChaser.playerId, l.card.suit)
                    : false;
                if (memVoid) penalty += 0.35;   // they'd ruff and bank a trick
            }
            // L4 — prefer a suit still widely held, so somebody else takes it.
            return { l, score: p + penalty, cost: DecisionEngine.cardCost(l.card, sit.evalCtx) };
        }).sort((a, b) => a.score - b.score || a.cost - b.cost);

        return { entry: scored[0].l, why: 'leading my safest low card in the suit least likely to come back to me' };
    }

    // ───────────────────────────────────────────────────────────────
    // POSTURE: BALANCE — on pace, take the right tricks at the right time
    // ───────────────────────────────────────────────────────────────

    _playBalance(sit) {
        if (sit.isLeading) {
            // R2 — if my needs are covered by bankable winners I can cash any
            // time, there is no reason to take a trick now. Probe instead.
            if (sit.bankable.length >= sit.tricksNeeded && sit.tricksNeeded > 0) {
                return { ...this._leadToDuck(sit), why: 'banked winners cover my target — probing rather than cashing early' };
            }
            return { ...this._leadToWin(sit), why: 'need more winners than I hold — playing for a trick now' };
        }

        const winners = DecisionEngine.getWinningCards(sit.legal, sit.trickSoFar, sit.trumpSuit);
        if (winners.length === 0) {
            return { entry: DecisionEngine.cheapestByCost(sit.legal, sit.evalCtx), why: 'cannot win — cheapest card' };
        }

        // Take the trick only if I'm actually behind pace. Otherwise duck and
        // keep the winner for when I need it. This is the fix for "robo grabs
        // the first trick it can and then spends the round trying to duck".
        // R2 — the question is not "can I win this?" but "do I need to win
        // THIS one?". If banked winners already cover my target I can duck now
        // and cash later; the old engine took every trick it could and then
        // spent the rest of the round trying to give them back.
        const shortOfCover = sit.bankable.length < sit.tricksNeeded;
        const behindPace   = sit.slack < 0.25;
        if (behindPace || shortOfCover) {
            const scored = winners.map(w => ({
                entry: w,
                survival: DecisionEngine.survivalProbability(w.card, sit.evalCtx),
                cost: DecisionEngine.cardCost(w.card, sit.evalCtx),
            })).filter(s => s.survival >= TUNING.SAFE_WIN_THRESHOLD)
              .sort((a, b) => a.cost - b.cost);
            if (scored.length > 0) {
                const reason = shortOfCover
                    ? `only ${sit.bankable.length} banked winner(s) for ${sit.tricksNeeded} still needed — taking a safe cheap trick now`
                    : `behind pace (slack ${sit.slack.toFixed(1)}) — taking a safe cheap trick`;
                return { entry: scored[0].entry, why: reason };
            }
        }
        return { ...this._playShed(sit), why: `target already covered (slack ${sit.slack.toFixed(1)}) — ducking, winners kept for when I need them` };
    }

    // ───────────────────────────────────────────────────────────────
    // POSTURE: SABOTAGE — my own score is locked; damage the field
    // ───────────────────────────────────────────────────────────────

    _playSabotage(sit) {
        const target = sit.opponentStates[0]; // highest swing value
        const winners = DecisionEngine.getWinningCards(sit.legal, sit.trickSoFar, sit.trumpSuit);

        if (!sit.isLeading) {
            const leaderId = DecisionEngine.currentTrickLeaderId(sit.trickSoFar, sit.trumpSuit);
            const leaderState = sit.opponentStates.find(o => o.playerId === leaderId);

            // S2 — a chaser is about to bank a trick they need. Take it away.
            if (leaderState && leaderState.state === 'chasing' && winners.length > 0) {
                const pick = DecisionEngine.cheapestByCost(winners, sit.evalCtx);
                return { entry: pick, why: `denying ${leaderState.name}, who still needs ${leaderState.needs} trick(s)` };
            }
            // A player who has met their bid is winning — perfect, that busts them.
            if (leaderState && leaderState.state === 'safe') {
                const losers = sit.legal.filter(l => !winners.includes(l));
                const pool = losers.length > 0 ? losers : sit.legal;
                return {
                    entry: DecisionEngine.cheapestByCost(pool, sit.evalCtx),
                    why: `letting ${leaderState.name} win — they have already met their bid`,
                };
            }
            const losers = sit.legal.filter(l => !winners.includes(l));
            const pool = losers.length > 0 ? losers : sit.legal;
            return { entry: DecisionEngine.cheapestByCost(pool, sit.evalCtx), why: 'no useful damage available — playing cheap' };
        }

        // Leading. If the top target must duck, feed them a trick they may be
        // forced to take. If the top target still needs tricks, take control.
        if (target && target.state === 'safe') {
            const nonTrump = sit.legal.filter(l => l.card.suit !== sit.trumpSuit);
            const pool = nonTrump.length > 0 ? nonTrump : sit.legal;
            const notVoid = pool.filter(l => !(sit.evalCtx.memory.isKnownVoid
                && sit.evalCtx.memory.isKnownVoid(target.playerId, l.card.suit)));
            const finalPool = notVoid.length > 0 ? notVoid : pool;
            return {
                entry: DecisionEngine.cheapestByCost(finalPool, sit.evalCtx),
                why: `leading low at ${target.name}, who has met their bid and must duck`,
            };
        }
        if (target && target.state === 'chasing' && sit.bankable.length > 0) {
            const bankableLegal = sit.legal.filter(l =>
                sit.bankable.some(b => b.card.suit === l.card.suit && b.card.rank === l.card.rank));
            if (bankableLegal.length > 0) {
                return {
                    entry: DecisionEngine.dearestByCost(bankableLegal, sit.evalCtx),
                    why: `taking a trick off ${target.name}, who still needs ${target.needs}`,
                };
            }
        }
        return { entry: DecisionEngine.cheapestByCost(sit.legal, sit.evalCtx), why: 'score locked — playing out cheaply' };
    }

    // ───────────────────────────────────────────────────────────────
    // HELPERS
    // ───────────────────────────────────────────────────────────────

    _byMaxDanger(entries, sit) {
        return entries
            .map(l => ({ l, danger: DecisionEngine.dangerScore(l.card, sit.evalCtx), cost: DecisionEngine.cardCost(l.card, sit.evalCtx) }))
            .sort((a, b) => b.danger - a.danger || b.cost - a.cost)[0].l;
    }

    _suitGlyph(suit) {
        return { Spades: '♠', Hearts: '♥', Diamonds: '♦', Clubs: '♣' }[suit] || '';
    }

    _trace(headline, why, lines) {
        return { tier: 'Expert', kind: 'play', headline, lines: lines || [why] };
    }

    _buildPlayTrace(sit, choice) {
        const modeNames = {
            A: 'must win every remaining trick',
            B: 'bid met — must not win another',
            C: 'mixed — win some, duck some',
            D: 'bid unreachable, score locked — spoiler play',
        };
        const lines = [
            `Bid ${sit.bid}, won ${sit.tricksWon} → need ${sit.tricksNeeded} of ${sit.tricksRemaining} remaining (mode ${sit.mode}: ${modeNames[sit.mode]})`,
            `Trick equity ${sit.expectedRemainingTricks.toFixed(1)} → slack ${sit.slack >= 0 ? '+' : ''}${sit.slack.toFixed(1)} · posture ${sit.posture}`,
            `Table ${sit.regime === 'under' ? 'UNDERBID' : 'OVERBID'} by ${Math.abs(sit.tableSurplus)} (live surplus ${sit.liveSurplus >= 0 ? '+' : ''}${sit.liveSurplus})`,
            `Banked winners: ${sit.bankable.length ? sit.bankable.map(b => `${b.card.rank}${this._suitGlyph(b.card.suit)}`).join(' ') : 'none'}`
                + (sit.surplus.length ? ` · surplus to shed: ${sit.surplus.map(b => `${b.card.rank}${this._suitGlyph(b.card.suit)}`).join(' ')}` : ''),
        ];
        if (sit.trumpSuit !== NO_TRUMP) lines.push(`Trumps still out: ~${sit.outstandingTrumps.toFixed(1)}`);
        if (sit.opponentStates.length > 0) {
            lines.push(`Opponents: ${sit.opponentStates.map(o => `${o.name} ${o.tricksWon}/${o.bid} ${o.state}`).join(' · ')}`);
        }
        lines.push(`Choice: ${choice.why}`);
        return {
            tier: 'Expert', kind: 'play',
            headline: `${sit.posture} — ${choice.why}`,
            lines,
        };
    }
}

// ─────────────────────────────────────────────────────────────────────────
// FACTORY
// ─────────────────────────────────────────────────────────────────────────

class StrategyFactory {
    /**
     * @param {string} difficulty - 'Standard'|'Expert' (legacy 'Normal'|'Master' accepted)
     * @returns {Strategy}
     */
    static create(difficulty) {
        switch (difficulty) {
            case 'Standard':
            case 'Normal':
                return new StandardStrategy();
            case 'Expert':
            case 'Master':
                return new ExpertStrategy();
            default:
                console.warn(`[Robo] Unknown difficulty '${difficulty}', defaulting to Standard`);
                return new StandardStrategy();
        }
    }

    /** @returns {object} CardMemory or NoOpCardMemory */
    static createMemory(difficulty) {
        const { CardMemory, NoOpCardMemory } = require('./card-memory');
        switch (difficulty) {
            case 'Expert':
            case 'Master':
                return new CardMemory();
            default:
                return new NoOpCardMemory();
        }
    }

    /** @returns {object} RoundContext or NoOpRoundContext */
    static createRoundContext(difficulty, playerId) {
        const { RoundContext, NoOpRoundContext } = require('./round-context');
        switch (difficulty) {
            case 'Expert':
            case 'Master':
                return new RoundContext(playerId);
            default:
                return new NoOpRoundContext();
        }
    }
}

module.exports = { Strategy, StandardStrategy, ExpertStrategy, StrategyFactory };
