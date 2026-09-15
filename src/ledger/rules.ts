import {
  DEFAULT_MAX_PASS_WINDOW,
  DEFAULT_MAX_RECORDING_LAG,
  type RulesConfig,
} from "@ticketto/ledger-rules";

/**
 * The rules configuration the server's ledger runs with (`F-008` plan §5.2).
 * `backend-memory` runs `ledger-rules` unconfigured in development and test, so
 * every limit is the rules' own default. In staging the ledger service runs the
 * rules with a configuration of its own; kippu-api assumes the defaults there too,
 * until the service declares its limits.
 */
export const LEDGER_RULES_CONFIG: RulesConfig = {};

/** The limits of the rules configuration that Kippu's own settings are bounded by. */
export interface LedgerLimits {
  /** The longest pass window the ledger accepts, in milliseconds (`T-008-17`). */
  readonly maxPassWindow: number;
  /**
   * How long after a pass's `notAfter` the ledger may still record it, in
   * milliseconds (`T-008-10`): past that, an unrecorded pass never will be.
   */
  readonly maxRecordingLag: number;
}

/** The limits `config` sets, with the rules' defaults for any it leaves out. */
export function ledgerLimits(config: RulesConfig = LEDGER_RULES_CONFIG): LedgerLimits {
  return {
    maxPassWindow: config.maxPassWindow ?? DEFAULT_MAX_PASS_WINDOW,
    maxRecordingLag: config.maxRecordingLag ?? DEFAULT_MAX_RECORDING_LAG,
  };
}
