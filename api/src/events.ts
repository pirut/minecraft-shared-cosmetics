import { EventEmitter } from "node:events";

/**
 * What servers hear about over GET /v1/events.
 * player:  a player's owned or equipped cosmetics changed; carries the full new state.
 * catalog: a cosmetic was created or updated; servers re-fetch the catalog.
 */
export type ChangeEvent =
  | { type: "player"; uuid: string; owned: string[]; equipped: Record<string, string> }
  | { type: "catalog"; id: string };

/**
 * In-process fan-out of changes to connected servers. One API instance only: running several
 * behind a load balancer needs a shared bus (e.g. Postgres LISTEN/NOTIFY) in its place.
 */
export class ChangeFeed {
  private readonly emitter = new EventEmitter();

  constructor() {
    // One listener per connected server; there is no fixed upper bound.
    this.emitter.setMaxListeners(0);
  }

  publish(event: ChangeEvent): void {
    this.emitter.emit("change", event);
  }

  subscribe(listener: (event: ChangeEvent) => void): () => void {
    this.emitter.on("change", listener);
    return () => this.emitter.off("change", listener);
  }
}
