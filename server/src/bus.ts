import { EventEmitter } from "node:events";
import type { ServerPush } from "@ad/shared";

// Fan-out of server changes to every open browser tab (via /api/events) and to tests.
export class Bus {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(100);
  }

  publish(push: ServerPush): void {
    this.emitter.emit("push", push);
  }

  subscribe(listener: (push: ServerPush) => void): () => void {
    this.emitter.on("push", listener);
    return () => this.emitter.off("push", listener);
  }
}
