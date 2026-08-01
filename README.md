# Judgment Clubhouse

Multiplayer Judgment (Oh Hell) — Node.js + Express + Socket.IO, server-authoritative,
vanilla JS client, in-memory state.

```bash
npm install
npm start                 # http://localhost:5000
```

## Robo (AI) players

Two tiers, configured by the host from the lobby.

| | Standard | Expert |
|---|---|---|
| Bidding | Naive per-card scores, summed and rounded | Win-probability model → EV-maximising bid |
| Memory | None | Every card played, every revealed void |
| Table awareness | None | Bid ledger, over/under regime, opponent states |
| Play | 3-mode state machine, this trick only | 4-posture engine with a running plan |

**Standard is deliberately frozen.** It is meant to be the weaker opponent; the
gap between tiers is the product.

### Architecture

```
server.js                        Game engine. Robo hooks only — no strategy logic.
server-src/
  decision-engine.js             Pure static heuristics. No state, no side effects.
  strategy.js                    StandardStrategy / ExpertStrategy / StrategyFactory. Stateless.
  card-memory.js                 CardMemory / NoOpCardMemory — cards played, voids.
  round-context.js               RoundContext / NoOpRoundContext — bid ledger, trick winners.
  player.js                      RoboPlayer — owns strategy + brain, holds the reasoning trace.
```

A robo's private state is a **brain**:

```js
brain = { memory: CardMemory, round: RoundContext }
```

passed into every strategy call. The split matters: `brain` is what this robo
privately knows and has inferred, while `gs` + `context` is what the table
publicly shows. RoundContext stores **observed facts only** — every derived value
(posture, slack, banked winners, opponent states) is recomputed fresh each turn
by pure functions in `decision-engine.js`, so there is no staleness bug class.

Strategy methods return objects, not bare values:

```js
selectBid(gs, playerIndex, brain, context)   // -> { bid,  trace }
selectCard(gs, playerIndex, brain, context)  // -> { card, trace }
```

The trace travels in the return value, which is what keeps strategies stateless;
`RoboPlayer` holds on to it.

### How the Expert bids

1. **Per-card win probabilities**, from how many higher cards in the suit are
   unaccounted for, adjusted for ruff risk and long-suit establishment.
2. **In-play factor.** Only `numPlayers × handSize` of the 52 cards get dealt. In
   a 4-player 6-card round that is 24 cards, so an unseen King is only ~39%
   likely to exist in anybody's hand at all.
3. **Shading** against prior bids, weighted by bidding position — heavy prior
   bids mean strong opponent hands, so shade down; the first bidder ignores the
   signal, the dealer weights it fully.
4. **Calibration** onto real trick counts. Tricks are zero-sum across the table,
   but a model looking only at its own hand cannot enforce that and drifts
   optimistic. Two fitted constants correct the scale.
5. **EV maximisation.** Scoring is `+(10 + bid)` on an exact hit and `−bid` on a
   miss, so bidding 0 has *zero* downside. The engine builds a Poisson-binomial
   distribution over tricks won and picks `argmax P(b)·(10 + 2b) − b` rather
   than rounding a point estimate.

### How the Expert plays

Each turn it builds a situation snapshot and picks one of four postures:

| Posture | When | Behaviour |
|---|---|---|
| **GRAB** | Needs tricks, short of cover | Draw trumps when long; cash side-suit winners before they can be ruffed; win with the cheapest card that survives the players still to act |
| **SHED** | Target met or projected to overshoot | Never lead a banked winner or a trump; safe high discard under a winner it cannot beat; when forced to win, burn its biggest card |
| **BALANCE** | On pace | Ducks if banked winners already cover the target, cashing them later instead |
| **SABOTAGE** | Bid unreachable, score locked | Overtake players who still need tricks; let players who have met their bid win |

The **table regime** modulates all of it. The hook rule guarantees total bids
never equal the hand size, so every round is either underbid (spare tricks exist
and somebody must eat them → duck early) or overbid (tricks are scarcer than
claimed → grab yours early).

### Diagnostics

| Flag | Effect |
|---|---|
| `ROBO_TELEMETRY=1` | One `[RoboStat]` console line per robo per round — bid, tricks won, delta, result |
| `ROBO_TRACE=0` | Disables the host-only reasoning panel (on by default) |
| `ROBO_FAST_TEST=1` | Shrinks think-time delays for automated testing. **Never set in production** |

The **reasoning panel** appears as a 🤖 button, bottom-right, for the host only
and only when robos are at the table. It shows each decision's mode, slack,
table regime, banked winners and the specific rule that produced the choice.

See `tests/README.md` for the three test harnesses.

## Known limitations

- Opponent hand inference is not implemented; the engine reasons from bids,
  revealed voids and cards played, not from a modelled distribution over hands.
- Endgame play is heuristic. With three or fewer tricks left an exact or
  Monte-Carlo search would be both cheap and considerably stronger.
- Tuning constants are collected in `TUNING` at the top of `decision-engine.js`
  and were fitted by hand against `tests/calibrate.js`. A proper search would
  do better.
