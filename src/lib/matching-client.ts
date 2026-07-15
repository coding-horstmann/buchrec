import type { MatchResult, NormalizedRecord } from "../types";
import { runMatching } from "./matching";

export function runMatchingInBrowser(records: NormalizedRecord[], dateTolerance: number, amountTolerance = 0.02): Promise<MatchResult> {
  if (typeof Worker === "undefined") return Promise.resolve(runMatching(records, dateTolerance, amountTolerance));
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./matching.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event: MessageEvent<MatchResult>) => {
      resolve(event.data);
      worker.terminate();
    };
    worker.onerror = (event) => {
      reject(new Error(event.message || "Matching-Worker ist fehlgeschlagen."));
      worker.terminate();
    };
    worker.postMessage({ records, dateTolerance, amountTolerance });
  });
}
