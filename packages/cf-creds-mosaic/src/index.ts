/**
 * Credential-aware Mosaic connector: every query — including the SQL Mosaic
 * generates on its own for brushes and linked selections — first ensures the
 * manager's current credentials are installed in DuckDB-Wasm. DuckDB stores
 * credential *strings*, not a provider callback, so rotation means
 * re-installing; views survive it because they store S3 paths, not creds.
 *
 * Install prefers `CREATE OR REPLACE SECRET` and falls back to `SET s3_*`
 * (current duckdb-wasm builds reject the former); the resolved mode is
 * reported through `onInstall`.
 *
 * The region installs alongside the keys: under the key contract it rides in
 * the envelope, so a keyed page passes no region at all and each install
 * takes the one belonging to the credentials it is installing.
 *
 * @packageDocumentation
 */

import type { CredentialManager } from "@habemus-papadum/cf-browser-credentials";
import type { AwsCredentials } from "@habemus-papadum/cf-creds-aws";
import type { Connector } from "@uwdata/mosaic-core";

export type InstallMode = "CREATE SECRET" | "SET s3_*";

export interface CredentialAwareOptions {
  /**
   * Region to install. Optional when the envelope carries one (the key
   * contract): each install then takes the region from the credentials it is
   * installing, and an explicit value here still wins.
   */
  region?: string;
  /** When it returns true, force a fresh mint on every query. */
  forceRefresh?: () => boolean;
  /** Observe each install (mode resolution, rotation counting). */
  onInstall?: (mode: InstallMode, creds: AwsCredentials) => void;
}

const q = (value: string) => `'${value.replaceAll("'", "''")}'`;

export function credentialAwareConnector(
  base: Connector,
  manager: CredentialManager<AwsCredentials>,
  options?: CredentialAwareOptions,
): Connector;
/**
 * @deprecated The region is part of the credential now. Pass it as
 * `options.region` — or drop it entirely and let the envelope supply it.
 */
export function credentialAwareConnector(
  base: Connector,
  manager: CredentialManager<AwsCredentials>,
  region: string,
  options?: CredentialAwareOptions,
): Connector;
export function credentialAwareConnector(
  base: Connector,
  manager: CredentialManager<AwsCredentials>,
  regionOrOptions: string | CredentialAwareOptions = {},
  legacyOptions: CredentialAwareOptions = {},
): Connector {
  const options: CredentialAwareOptions =
    typeof regionOrOptions === "string"
      ? { ...legacyOptions, region: legacyOptions.region ?? regionOrOptions }
      : regionOrOptions;
  let installedKey: string | undefined;
  let installing: Promise<void> | undefined;
  let mode: InstallMode | undefined;

  async function install(creds: AwsCredentials): Promise<void> {
    // Resolved per install, not once at construction: a rotation can carry a
    // different region, and the credential is the only place it comes from.
    const region = options.region ?? creds.region;
    if (!region) {
      throw new Error(
        "no region to install — pass options.region, or use a broker route that returns one",
      );
    }
    const secretSql = `CREATE OR REPLACE SECRET broker (
      TYPE s3,
      KEY_ID ${q(creds.accessKeyId)},
      SECRET ${q(creds.secretAccessKey)},
      SESSION_TOKEN ${q(creds.sessionToken)},
      REGION ${q(region)}
    );`;
    const setSql = `
      SET s3_region = ${q(region)};
      SET s3_access_key_id = ${q(creds.accessKeyId)};
      SET s3_secret_access_key = ${q(creds.secretAccessKey)};
      SET s3_session_token = ${q(creds.sessionToken)};
    `;
    if (mode === undefined) {
      try {
        await base.query({ type: "exec", sql: secretSql });
        mode = "CREATE SECRET";
      } catch {
        await base.query({ type: "exec", sql: setSql });
        mode = "SET s3_*";
      }
    } else {
      await base.query({ type: "exec", sql: mode === "CREATE SECRET" ? secretSql : setSql });
    }
    installedKey = creds.accessKeyId;
    options.onInstall?.(mode, creds);
  }

  async function ensure(): Promise<void> {
    const creds = options.forceRefresh?.() ? await manager.refresh() : await manager.get();
    if (creds.accessKeyId === installedKey) return;
    installing ??= install(creds).finally(() => {
      installing = undefined;
    });
    await installing;
  }

  const query = async (request: { type?: string; sql: string }) => {
    await ensure();
    return (base.query as (r: unknown) => Promise<unknown>)(request);
  };
  return { query } as Connector;
}
