import { describe, expect, it } from "vitest";
import { passwordChecks } from "./PasswordResetPages";

describe("reset page password checks (mirror the server policy)", () => {
  it("needs 10+ characters and 3 character classes; Arabic-keyboard digits count as digits", () => {
    expect(passwordChecks("short1A!").ok).toBe(false);
    expect(passwordChecks("alllowercaseletters").ok).toBe(false);
    expect(passwordChecks("Fleet-Pass-2026").ok).toBe(true);
    expect(passwordChecks("fleetpass٢٠٢٦!")).toMatchObject({ length: true, classes: true, ok: true });
    expect(passwordChecks("x".repeat(129) + "A1").ok).toBe(false);
  });
});
