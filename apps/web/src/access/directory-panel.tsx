import type {
  CompanyGroupSummary,
  CreatedDirectoryToken,
  DirectoryImportFailure,
  DirectoryImportSummary,
  DirectoryStatus,
  DirectoryToken,
  Group,
} from "@extispex/contracts";
import { type FormEvent, useState } from "react";
import { ApiError } from "../api/api-request.ts";
import {
  createDirectoryToken,
  importDirectoryFile,
  revokeDirectoryToken,
  setCompanyGroups,
} from "../api/identity-api.ts";
import { useAccess } from "../sign-in/access-context.ts";
import { formatRelativeTime } from "../traces/trace-formatting.ts";
import { CopyButton } from "../ui/copy-button.tsx";
import { AlertIcon, CheckIcon, PlusIcon } from "../ui/icons.tsx";
import { useNow } from "../ui/use-now.ts";
import { SCIM_BASE_PATH } from "./access-rules.ts";

/** How many of a refused file's problems the page lists; the rest are counted. */
const SHOWN_PROBLEM_COUNT = 20;

function describeTime(isoTime: string | null, nowUnixMilliseconds: number): string {
  return isoTime === null ? "never" : formatRelativeTime(Date.parse(isoTime), nowUnixMilliseconds);
}

/**
 * The sync with the company's directory: tokens for SCIM, imported files, and which Company groups
 * are mapped to which Groups. Mapping a Company group only decides membership; Roles are given on
 * each Project's page.
 */
export function DirectoryPanel(
  { status, groups, onChange }: {
    status: DirectoryStatus;
    groups: Group[];
    onChange: () => void;
  },
) {
  const nowUnixMilliseconds = useNow(15_000);
  return (
    <section className="panel directory-panel" aria-labelledby="directory-title">
      <h2 id="directory-title" className="panel-title">Directory sync</h2>
      <p className="directory-summary">
        Last SCIM request {describeTime(status.lastScimRequestAt, nowUnixMilliseconds)} ·{" "}
        {status.provisionedUserCount === 1 ? "1 person" : `${status.provisionedUserCount} people`}
        {" "}
        from the directory · {status.companyGroupCount === 1
          ? "1 Company group"
          : `${status.companyGroupCount} Company groups`}
      </p>
      <ScimTokens tokens={status.tokens} onChange={onChange} />
      <FileImport recentImports={status.recentImports} onChange={onChange} />
      <CompanyGroupMappings
        companyGroups={status.companyGroups}
        companyGroupCount={status.companyGroupCount}
        groups={groups}
        onChange={onChange}
      />
    </section>
  );
}

function ScimTokens({ tokens, onChange }: { tokens: DirectoryToken[]; onChange: () => void }) {
  const { credentials } = useAccess();
  const nowUnixMilliseconds = useNow(15_000);
  const [tokenName, setTokenName] = useState("");
  const [createdToken, setCreatedToken] = useState<CreatedDirectoryToken | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [isChanging, setIsChanging] = useState(false);
  const scimUrl = `${globalThis.location.origin}${SCIM_BASE_PATH}`;

  const runChange = async (makeChange: () => Promise<void>) => {
    setIsChanging(true);
    setProblem(null);
    try {
      await makeChange();
      onChange();
    } catch (error) {
      setProblem((error as Error).message);
    } finally {
      setIsChanging(false);
    }
  };

  const submit = (submitEvent: FormEvent) => {
    submitEvent.preventDefault();
    if (tokenName.trim() === "") {
      setProblem("Name the token after the directory that uses it, such as Microsoft Entra.");
      return;
    }
    runChange(async () => {
      setCreatedToken(await createDirectoryToken(credentials, tokenName.trim()));
      setTokenName("");
    });
  };

  return (
    <div className="directory-section">
      <h3 className="directory-section-title">SCIM</h3>
      <p className="directory-section-text">
        Point the directory's SCIM 2.0 provisioning at this address, with a token as its secret.
      </p>
      <div className="new-api-key-value scim-url">
        <code className="new-api-key-secret">{scimUrl}</code>
        <CopyButton value={scimUrl} label="SCIM address" />
      </div>
      <form className="panel-form directory-form" onSubmit={submit}>
        <label htmlFor="directory-token-name" className="field-label">New token's name</label>
        <div className="inline-form">
          <input
            id="directory-token-name"
            className="text-input"
            autoComplete="off"
            maxLength={64}
            placeholder="Microsoft Entra"
            value={tokenName}
            onChange={(changeEvent) => setTokenName(changeEvent.target.value)}
          />
          <button type="submit" className="button button-primary" disabled={isChanging}>
            <PlusIcon size={14} />
            Create token
          </button>
        </div>
        {problem !== null && (
          <p className="form-problem" role="alert">
            <AlertIcon size={14} />
            {problem}
          </p>
        )}
      </form>
      {createdToken !== null && (
        <div className="new-api-key" role="status" aria-label="New directory token">
          <p className="new-api-key-title">
            <CheckIcon size={15} />
            Copy the token for {createdToken.name} now. It is shown only once.
          </p>
          <div className="new-api-key-value">
            <code className="new-api-key-secret">{createdToken.token}</code>
            <CopyButton value={createdToken.token} label="Directory token" />
          </div>
          <div className="new-api-key-actions">
            <button
              type="button"
              className="button button-ghost button-small"
              onClick={() =>
                setCreatedToken(null)}
            >
              Done
            </button>
          </div>
        </div>
      )}
      {tokens.length > 0 && (
        <div className="table-scroll">
          <table className="data-table api-key-table directory-token-table">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col" className="column-key">Token</th>
                <th scope="col" className="column-numeric">Last used</th>
                <th scope="col" className="column-actions">
                  <span className="visually-hidden">Status</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {tokens.map((token) => (
                <tr
                  key={token.id}
                  className={token.revokedAt === null
                    ? "api-key-row"
                    : "api-key-row api-key-revoked"}
                >
                  <td className="api-key-name">{token.name}</td>
                  <td className="column-key">
                    <code className="api-key-prefix">{token.tokenPrefix}…</code>
                  </td>
                  <td className="column-numeric text-muted">
                    {describeTime(token.lastUsedAt, nowUnixMilliseconds)}
                  </td>
                  <td className="column-actions">
                    {token.revokedAt === null
                      ? (
                        <button
                          type="button"
                          className="button button-ghost button-danger button-small"
                          disabled={isChanging}
                          aria-label={`Revoke ${token.name}`}
                          onClick={() =>
                            runChange(async () => {
                              await revokeDirectoryToken(credentials, token.id);
                              if (createdToken?.id === token.id) setCreatedToken(null);
                            })}
                        >
                          Revoke
                        </button>
                      )
                      : <span className="status-text">Revoked</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function describeImport(summary: DirectoryImportSummary): string {
  return `${summary.createdCount} created, ${summary.updatedCount} updated, ` +
    `${summary.deactivatedCount} deactivated, ${summary.unchangedCount} unchanged`;
}

function FileImport(
  { recentImports, onChange }: {
    recentImports: DirectoryImportSummary[];
    onChange: () => void;
  },
) {
  const { credentials } = useAccess();
  const nowUnixMilliseconds = useNow(15_000);
  const [file, setFile] = useState<File | null>(null);
  const [fileInputKey, setFileInputKey] = useState(0);
  const [result, setResult] = useState<DirectoryImportSummary | null>(null);
  const [failure, setFailure] = useState<{ message: string; problems: string[] } | null>(null);
  const [isImporting, setIsImporting] = useState(false);

  const submit = async (submitEvent: FormEvent) => {
    submitEvent.preventDefault();
    setResult(null);
    setFailure(null);
    if (file === null) {
      setFailure({ message: "Choose a CSV or JSON file first.", problems: [] });
      return;
    }
    setIsImporting(true);
    try {
      const isJson = file.name.toLowerCase().endsWith(".json") || file.type === "application/json";
      setResult(
        await importDirectoryFile(
          credentials,
          await file.text(),
          isJson ? "application/json" : "text/csv",
        ),
      );
      setFile(null);
      setFileInputKey((key) => key + 1);
      onChange();
    } catch (error) {
      const problems = error instanceof ApiError
        ? (error.responseBody as Partial<DirectoryImportFailure> | null)?.problems ?? []
        : [];
      setFailure({
        message: (error as Error).message,
        problems: problems.map((problem) =>
          problem.row === 0 ? problem.message : `Row ${problem.row}: ${problem.message}`
        ),
      });
    } finally {
      setIsImporting(false);
    }
  };

  return (
    <div className="directory-section">
      <h3 className="directory-section-title">Import a file</h3>
      <p className="directory-section-text">
        For a directory without SCIM: a CSV file with the columns <code>email</code>,{" "}
        <code>displayName</code>, <code>companyGroups</code> separated by <code>|</code>, and{" "}
        <code>active</code>. Every row applies, or none does. Roles cannot be imported.
      </p>
      <form className="panel-form directory-form" onSubmit={submit}>
        <label htmlFor="directory-import-file" className="field-label">CSV or JSON file</label>
        <div className="inline-form">
          <input
            key={fileInputKey}
            id="directory-import-file"
            className="file-input"
            type="file"
            accept=".csv,.json,text/csv,application/json"
            onChange={(changeEvent) => setFile(changeEvent.target.files?.[0] ?? null)}
          />
          <button type="submit" className="button button-secondary" disabled={isImporting}>
            Import file
          </button>
        </div>
      </form>
      {result !== null && (
        <p className="import-result" role="status">
          <CheckIcon size={14} />
          Imported: {describeImport(result)}.
        </p>
      )}
      {failure !== null && (
        <div className="import-problems" role="alert">
          <p className="form-problem">
            <AlertIcon size={14} />
            {failure.message}
          </p>
          {failure.problems.length > 0 && (
            <ul>
              {failure.problems.slice(0, SHOWN_PROBLEM_COUNT).map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
              {failure.problems.length > SHOWN_PROBLEM_COUNT && (
                <li>and {failure.problems.length - SHOWN_PROBLEM_COUNT} more</li>
              )}
            </ul>
          )}
        </div>
      )}
      {recentImports.length > 0 && (
        <ul className="recent-imports" aria-label="Recent imports">
          {recentImports.map((recentImport) => (
            <li key={recentImport.id}>
              <span className="text-muted">
                {describeTime(recentImport.importedAt, nowUnixMilliseconds)},{" "}
                {recentImport.format.toUpperCase()}:
              </span>{" "}
              {describeImport(recentImport)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CompanyGroupMappings(
  { companyGroups, companyGroupCount, groups, onChange }: {
    companyGroups: CompanyGroupSummary[];
    companyGroupCount: number;
    groups: Group[];
    onChange: () => void;
  },
) {
  const { credentials, reloadAccess } = useAccess();
  const [problem, setProblem] = useState<string | null>(null);
  const [isChanging, setIsChanging] = useState(false);

  const changeMapping = async (group: Group, companyGroups: string[]) => {
    setIsChanging(true);
    setProblem(null);
    try {
      await setCompanyGroups(credentials, group.id, companyGroups);
      onChange();
      // The signed-in user may have joined or left a Group with Roles.
      reloadAccess();
    } catch (error) {
      setProblem((error as Error).message);
    } finally {
      setIsChanging(false);
    }
  };

  return (
    <div className="directory-section">
      <h3 className="directory-section-title">Company groups</h3>
      {companyGroups.length === 0
        ? (
          <p className="directory-section-text">
            None yet. They appear when the directory or a file names them.
          </p>
        )
        : (
          <>
            <p className="directory-section-text">
              Members of a Company group join the Groups it is mapped to.
              {companyGroupCount > companyGroups.length &&
                ` The first ${companyGroups.length} of ${companyGroupCount} are shown.`}
            </p>
            {problem !== null && (
              <p className="form-problem" role="alert">
                <AlertIcon size={14} />
                {problem}
              </p>
            )}
            <ul className="company-group-list">
              {companyGroups.map((companyGroup) => (
                <CompanyGroupItem
                  key={companyGroup.id}
                  companyGroup={companyGroup}
                  groups={groups}
                  isChanging={isChanging}
                  onChangeMapping={changeMapping}
                />
              ))}
            </ul>
          </>
        )}
    </div>
  );
}

function CompanyGroupItem(
  { companyGroup, groups, isChanging, onChangeMapping }: {
    companyGroup: CompanyGroupSummary;
    groups: Group[];
    isChanging: boolean;
    onChangeMapping: (group: Group, companyGroups: string[]) => Promise<void>;
  },
) {
  const mappedGroupIds = new Set(companyGroup.mappedGroups.map((group) => group.id));
  const candidates = groups.filter((group) => !mappedGroupIds.has(group.id));
  const [candidateId, setCandidateId] = useState("");
  const selectedCandidateId = candidates.some((group) => group.id === candidateId)
    ? candidateId
    : candidates[0]?.id ?? "";
  const names = new Set(
    [companyGroup.displayName, companyGroup.externalId].filter((name) => name !== null),
  );

  return (
    <li className="company-group-item" aria-label={`Company group ${companyGroup.displayName}`}>
      <div className="company-group-header">
        <span className="company-group-name">{companyGroup.displayName}</span>
        <span className="status-text">
          {companyGroup.memberCount === 1 ? "1 member" : `${companyGroup.memberCount} members`},
          {" "}
          {companyGroup.source === "scim" ? "SCIM" : "imported"}
        </span>
      </div>
      {companyGroup.mappedGroups.length > 0 && (
        <ul className="member-list" aria-label={`Groups that ${companyGroup.displayName} joins`}>
          {companyGroup.mappedGroups.map((mappedGroup) => {
            const group = groups.find((candidate) =>
              candidate.id === mappedGroup.id
            );
            return (
              <li key={mappedGroup.id} className="member-chip">
                <span className="member-chip-name">{mappedGroup.name}</span>
                {group !== undefined && (
                  <button
                    type="button"
                    className="member-chip-remove"
                    disabled={isChanging}
                    aria-label={`Unmap ${companyGroup.displayName} from ${mappedGroup.name}`}
                    onClick={() =>
                      onChangeMapping(
                        group,
                        group.companyGroups.filter((name) => !names.has(name)),
                      )}
                  >
                    ×
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {candidates.length > 0 && (
        <form
          className="inline-form group-member-form"
          onSubmit={(submitEvent) => {
            submitEvent.preventDefault();
            const group = candidates.find((candidate) => candidate.id === selectedCandidateId);
            if (group !== undefined) {
              onChangeMapping(group, [...group.companyGroups, companyGroup.displayName]);
            }
          }}
        >
          <select
            className="select-input"
            aria-label={`Group for ${companyGroup.displayName}`}
            value={selectedCandidateId}
            onChange={(changeEvent) =>
              setCandidateId(changeEvent.target.value)}
          >
            {candidates.map((group) => (
              <option key={group.id} value={group.id}>{group.name}</option>
            ))}
          </select>
          <button
            type="submit"
            className="button button-secondary button-small"
            disabled={isChanging}
          >
            Map to Group
          </button>
        </form>
      )}
    </li>
  );
}
