export type AgentPrecisionLevel =
  | 'exact'
  | 'bounded'
  | 'name-aggregate'
  | 'heuristic'
  | 'unknown';

export type AgentPrecisionUnit = 'call-sites' | 'symbols' | 'files';

export interface AgentPrecision {
  level: AgentPrecisionLevel;
  reason?: string;
  lowerBound?: number;
  upperBound?: number;
  unit?: AgentPrecisionUnit;
}

export interface AgentWarning {
  kind: string;
  message: string;
}

export interface AgentNextBestCall {
  tool: string;
  args: Record<string, unknown>;
  reason: string;
}

export function exactPrecision(reason?: string): AgentPrecision {
  return {
    level: 'exact',
    ...(reason ? { reason } : {}),
  };
}

export function boundedPrecision(
  lowerBound: number,
  upperBound: number,
  unit: AgentPrecisionUnit,
  reason: string,
): AgentPrecision {
  return { level: 'bounded', lowerBound, upperBound, unit, reason };
}

export function boundedUnquantifiedPrecision(reason: string): AgentPrecision {
  return { level: 'bounded', reason };
}

export function nameAggregatePrecision(
  unit: AgentPrecisionUnit,
  upperBound: number,
  reason: string,
): AgentPrecision {
  return { level: 'name-aggregate', upperBound, unit, reason };
}

export function heuristicPrecision(reason: string): AgentPrecision {
  return { level: 'heuristic', reason };
}

export function unknownPrecision(reason: string): AgentPrecision {
  return { level: 'unknown', reason };
}

export function agentWarning(kind: string, message: string): AgentWarning {
  return { kind, message };
}

export function nextBestCall(
  tool: string,
  args: Record<string, unknown>,
  reason: string,
): AgentNextBestCall {
  return { tool, args, reason };
}
