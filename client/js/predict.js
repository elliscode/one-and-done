// Client prediction: show what the client already knows a command will do (a token's new square,
// movement or an action spent) while the command is in flight, so a slow server doesn't make
// tokens snap back. The server stays authoritative: its next state replaces the prediction, and a
// rejected command drops it (reverting the screen). Dice results are never predicted.
//
// Predictions must be idempotent: applied to a state that already includes the change, they must
// change nothing (set absolute values, never "+= 1"). The server's state for a command usually
// arrives before its reply, so for a moment a prediction is applied on top of its own result.
//
//   view(serverState)   serverState with pending predictions applied (a copy, if any are pending)
//   onState()           call when a new server state arrives
//   run(send, apply)    shows apply(stateCopy) until send() settles; resolves to send()'s result
//                       (a falsy result or a rejection counts as a failed command)
export function createPredictor({ onChange = () => {}, settleTimeoutMs = 3000 } = {}) {
  const pending = new Map(); // id -> { apply, seqAtSend, settled }
  let nextId = 1;
  let stateSeq = 0;
  const drop = (id) => {
    if (pending.delete(id)) onChange();
  };

  return {
    get size() { return pending.size; },

    view(serverState) {
      if (!serverState || !pending.size) return serverState;
      const s = structuredClone(serverState);
      for (const p of pending.values()) {
        try { p.apply(s); } catch { /* the state moved on (e.g. a new scene): skip this one */ }
      }
      return s;
    },

    // A state that arrives after a command's reply includes that command, so its prediction goes.
    onState() {
      stateSeq++;
      for (const [id, p] of pending) if (p.settled && stateSeq > p.seqAtSend) pending.delete(id);
    },

    async run(send, apply) {
      const id = nextId++;
      const p = { apply, seqAtSend: stateSeq, settled: false };
      pending.set(id, p);
      onChange();
      let result;
      try {
        result = await send();
      } catch (err) {
        drop(id);
        throw err;
      }
      if (!result) {
        drop(id);
        return result;
      }
      p.settled = true;
      // The server pushes a command's state before replying, so if any state arrived since the
      // send, it includes this command. Otherwise wait for the next one (or give up after a while).
      if (stateSeq > p.seqAtSend) drop(id);
      else setTimeout(() => drop(id), settleTimeoutMs);
      return result;
    },
  };
}

// Chebyshev distance in squares between two positions (how core charges movement).
export const squaresBetween = (a, b) => Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y));
