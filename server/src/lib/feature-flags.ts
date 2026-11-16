import { config } from "../config.js";

/**
 * Accident case workflow switch. Off by default (ACCIDENT_WORKFLOW_ENABLED). Tests can override it with
 * setAccidentWorkflowFlag(); production never calls the setter.
 */
let override: boolean | null = null;

export const accidentWorkflowEnabled = (): boolean => override ?? config.ACCIDENT_WORKFLOW_ENABLED;

/** Test-only: force the flag (pass null to follow the configuration again). */
export function setAccidentWorkflowFlag(value: boolean | null) {
  override = value;
}

/**
 * Sensitive-document rule on legacy accidents (ACCIDENT_LEGACY_SENSITIVE_ENFORCEMENT). Separate from the workflow switch on purpose:
 * it is the only part of the accident feature that changes what existing users can see, so it is decided and rolled out on its own.
 * Workflow cases are always protected, whatever this says.
 */
let legacyOverride: boolean | null = null;

export const legacySensitiveEnforcementEnabled = (): boolean => legacyOverride ?? config.ACCIDENT_LEGACY_SENSITIVE_ENFORCEMENT;

/** Test-only: force the switch (pass null to follow the configuration again). */
export function setLegacySensitiveEnforcementFlag(value: boolean | null) {
  legacyOverride = value;
}
