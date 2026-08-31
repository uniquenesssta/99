import { buildDbQueryWorkerBootstrapSource } from "./dbQueryWorkerBootstrapSource";
import { buildDbQueryWorkerInstallStatusSource } from "./dbQueryWorkerInstallStatusSource";
import { buildDbQueryWorkerMergedPageSource } from "./dbQueryWorkerMergedPageSource";
import { buildDbQueryWorkerMetricsSource } from "./dbQueryWorkerMetricsSource";
import { buildDbQueryWorkerSharedSource } from "./dbQueryWorkerSharedSource";

export function buildDbQueryWorkerSource(): string {
  return [
    buildDbQueryWorkerSharedSource(),
    buildDbQueryWorkerMergedPageSource(),
    buildDbQueryWorkerMetricsSource(),
    buildDbQueryWorkerInstallStatusSource(),
    buildDbQueryWorkerBootstrapSource(),
  ].join("\n");
}
