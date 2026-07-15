/// <reference lib="webworker" />

import type { NormalizedRecord } from "../types";
import { runMatching } from "./matching";

interface MatchRequest {
  records: NormalizedRecord[];
  dateTolerance: number;
  amountTolerance: number;
}

self.onmessage = (event: MessageEvent<MatchRequest>) => {
  self.postMessage(runMatching(event.data.records, event.data.dateTolerance, event.data.amountTolerance));
};

export {};
