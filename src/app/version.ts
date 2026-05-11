/**
 * App version — displayed in the UI footer (MenuBar top-right) so bug
 * reports can be triaged to a specific build.
 *
 * This file MUST be kept in sync with package.json "version".
 * The release runbook (RELEASE.md) documents the composition pair:
 * bump package.json and this file in the same commit.
 *
 * Why not read package.json directly? Two reasons:
 * 1. Keeps tsconfig include clean (package.json lives outside src/)
 * 2. Works identically in dev and production — no Vite define wiring
 *
 * Failure mode this prevents: users on sonicpi.cc hit a bug, open the
 * Report Bug button, and have no way to tell which engine version they
 * were running. Without this, every bug report starts with "which version?"
 */
export const APP_VERSION = '1.5.0-beta.3'
