import type { Group, User } from "@extispex/contracts";
import { type FormEvent, useCallback, useState } from "react";
import {
  addGroupMember,
  createGroup,
  createUser,
  deleteGroup,
  listGroups,
  listUsers,
  removeGroupMember,
  updateUser,
} from "../api/identity-api.ts";
import { useAccess } from "../sign-in/access-context.ts";
import { MINIMUM_PASSWORD_LENGTH } from "./access-rules.ts";
import { AlertIcon, PlusIcon, ShieldIcon, TrashIcon } from "../ui/icons.tsx";
import { LoadError } from "../ui/load-error.tsx";
import { useApiResource } from "../ui/use-api-resource.ts";

interface AccessDirectory {
  users: User[];
  groups: Group[];
}

/** Users and Groups, for Instance admins. Roles are given per Project, on each Project's page. */
export function AccessPage() {
  const { credentials, showSignIn } = useAccess();
  const loadDirectory = useCallback(async (): Promise<AccessDirectory> => {
    const [{ users }, { groups }] = await Promise.all([
      listUsers(credentials),
      listGroups(credentials),
    ]);
    return { users, groups };
  }, [credentials]);
  const [directoryState, reloadDirectory] = useApiResource(loadDirectory);

  return (
    <div className="page page-constrained projects-page access-page">
      <div className="page-header">
        <div className="page-heading">
          <h1>Access</h1>
          <p className="page-subtitle">
            People belong to Groups, and each Project gives Groups a Role on its own page.
          </p>
        </div>
      </div>
      {directoryState.status === "loading" && <div className="panel panel-loading" />}
      {directoryState.status === "failed" && (
        <section className="panel">
          <LoadError
            subject="Users and Groups"
            message={directoryState.message}
            isSignInRequired={directoryState.isSignInRequired}
            onRetry={reloadDirectory}
            onSignInRequired={showSignIn}
          />
        </section>
      )}
      {directoryState.status === "loaded" && (
        <>
          <GroupsPanel
            groups={directoryState.resource.groups}
            users={directoryState.resource.users}
            onChange={reloadDirectory}
          />
          <UsersPanel users={directoryState.resource.users} onChange={reloadDirectory} />
        </>
      )}
    </div>
  );
}

/** Runs a change, reports its failure in the panel and reloads after success. */
function useChange(onChange: () => void) {
  const [problem, setProblem] = useState<string | null>(null);
  const [isChanging, setIsChanging] = useState(false);
  const runChange = async (makeChange: () => Promise<unknown>): Promise<boolean> => {
    setIsChanging(true);
    setProblem(null);
    try {
      await makeChange();
      onChange();
      return true;
    } catch (error) {
      setProblem((error as Error).message);
      return false;
    } finally {
      setIsChanging(false);
    }
  };
  return { problem, setProblem, isChanging, runChange };
}

function FormProblem({ problem }: { problem: string | null }) {
  if (problem === null) return null;
  return (
    <p className="form-problem" role="alert">
      <AlertIcon size={14} />
      {problem}
    </p>
  );
}

function GroupsPanel(
  { groups, users, onChange }: { groups: Group[]; users: User[]; onChange: () => void },
) {
  const { credentials, reloadAccess } = useAccess();
  const [groupName, setGroupName] = useState("");
  const { problem, setProblem, isChanging, runChange } = useChange(() => {
    onChange();
    // The signed-in user may have joined or left a Group with Roles.
    reloadAccess();
  });

  const submit = async (submitEvent: FormEvent) => {
    submitEvent.preventDefault();
    if (groupName.trim() === "") {
      setProblem("Give the Group a name, such as Support team.");
      return;
    }
    if (await runChange(() => createGroup(credentials, groupName.trim()))) setGroupName("");
  };

  return (
    <section className="panel groups-panel" aria-labelledby="groups-title">
      <h2 id="groups-title" className="panel-title">Groups</h2>
      <form className="panel-form" onSubmit={submit}>
        <label htmlFor="group-name-input" className="field-label">New Group's name</label>
        <div className="inline-form">
          <input
            id="group-name-input"
            className="text-input"
            autoComplete="off"
            maxLength={64}
            placeholder="Support team"
            value={groupName}
            onChange={(changeEvent) => setGroupName(changeEvent.target.value)}
          />
          <button type="submit" className="button button-primary" disabled={isChanging}>
            <PlusIcon size={14} />
            Create Group
          </button>
        </div>
        <FormProblem problem={problem} />
      </form>
      {groups.length === 0
        ? <p className="panel-empty-text">No Groups yet.</p>
        : (
          <ul className="group-list">
            {groups.map((group) => (
              <GroupItem
                key={group.id}
                group={group}
                users={users}
                isChanging={isChanging}
                runChange={runChange}
              />
            ))}
          </ul>
        )}
    </section>
  );
}

function GroupItem(
  { group, users, isChanging, runChange }: {
    group: Group;
    users: User[];
    isChanging: boolean;
    runChange: (makeChange: () => Promise<unknown>) => Promise<boolean>;
  },
) {
  const { credentials } = useAccess();
  const [isConfirmingDelete, setIsConfirmingDelete] = useState(false);
  const candidates = users.filter((user) =>
    user.deactivatedAt === null && !group.members.some((member) => member.id === user.id)
  );
  const [candidateId, setCandidateId] = useState("");
  const selectedCandidateId = candidates.some((user) => user.id === candidateId)
    ? candidateId
    : candidates[0]?.id ?? "";

  return (
    <li className="group-item" aria-label={`Group ${group.name}`}>
      <div className="group-item-header">
        <h3 className="group-item-name">{group.name}</h3>
        <span className="status-text">
          {group.members.length === 1 ? "1 member" : `${group.members.length} members`}
        </span>
        <span className="group-item-actions">
          {isConfirmingDelete
            ? (
              <span className="confirm-actions">
                <button
                  type="button"
                  className="button button-ghost button-small"
                  onClick={() => setIsConfirmingDelete(false)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="button button-danger-solid button-small"
                  autoFocus
                  disabled={isChanging}
                  onClick={() => runChange(() => deleteGroup(credentials, group.id))}
                >
                  Delete {group.name}
                </button>
              </span>
            )
            : (
              <button
                type="button"
                className="button button-ghost button-danger button-small"
                aria-label={`Delete Group ${group.name}`}
                onClick={() => setIsConfirmingDelete(true)}
              >
                <TrashIcon size={13} />
              </button>
            )}
        </span>
      </div>
      {group.members.length > 0 && (
        <ul className="member-list" aria-label={`Members of ${group.name}`}>
          {group.members.map((member) => (
            <li key={member.id} className="member-chip">
              <span className="member-chip-name" title={member.email}>{member.displayName}</span>
              <button
                type="button"
                className="member-chip-remove"
                disabled={isChanging}
                aria-label={`Remove ${member.displayName} from ${group.name}`}
                onClick={() =>
                  runChange(() => removeGroupMember(credentials, group.id, member.id))}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      {candidates.length > 0 && (
        <form
          className="inline-form group-member-form"
          onSubmit={(submitEvent) => {
            submitEvent.preventDefault();
            if (selectedCandidateId !== "") {
              runChange(() => addGroupMember(credentials, group.id, selectedCandidateId));
            }
          }}
        >
          <select
            className="select-input"
            aria-label={`User to add to ${group.name}`}
            value={selectedCandidateId}
            onChange={(changeEvent) => setCandidateId(changeEvent.target.value)}
          >
            {candidates.map((user) => (
              <option key={user.id} value={user.id}>{user.displayName} ({user.email})</option>
            ))}
          </select>
          <button
            type="submit"
            className="button button-secondary button-small"
            disabled={isChanging}
          >
            Add member
          </button>
        </form>
      )}
    </li>
  );
}

function UsersPanel({ users, onChange }: { users: User[]; onChange: () => void }) {
  const { credentials, user: currentUser } = useAccess();
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [isInstanceAdmin, setIsInstanceAdmin] = useState(false);
  const { problem, setProblem, isChanging, runChange } = useChange(onChange);

  const submit = async (submitEvent: FormEvent) => {
    submitEvent.preventDefault();
    if (email.trim() === "" || displayName.trim() === "") {
      setProblem("Enter the person's email address and name.");
      return;
    }
    if (password.length < MINIMUM_PASSWORD_LENGTH) {
      setProblem(`The password needs at least ${MINIMUM_PASSWORD_LENGTH} characters.`);
      return;
    }
    const isCreated = await runChange(() =>
      createUser(credentials, {
        email: email.trim(),
        displayName: displayName.trim(),
        password,
        isInstanceAdmin,
      })
    );
    if (isCreated) {
      setEmail("");
      setDisplayName("");
      setPassword("");
      setIsInstanceAdmin(false);
    }
  };

  return (
    <section className="panel users-panel" aria-labelledby="users-title">
      <h2 id="users-title" className="panel-title">Users</h2>
      <form className="panel-form user-form" onSubmit={submit}>
        <span className="field-label">New local account</span>
        <div className="user-form-fields">
          <input
            className="text-input"
            type="email"
            aria-label="Email"
            placeholder="name@company.com"
            autoComplete="off"
            value={email}
            onChange={(changeEvent) => setEmail(changeEvent.target.value)}
          />
          <input
            className="text-input"
            aria-label="Name"
            placeholder="Full name"
            autoComplete="off"
            maxLength={100}
            value={displayName}
            onChange={(changeEvent) => setDisplayName(changeEvent.target.value)}
          />
          <input
            className="text-input"
            type="password"
            aria-label="Initial password"
            placeholder={`Password, ${MINIMUM_PASSWORD_LENGTH}+ characters`}
            autoComplete="new-password"
            value={password}
            onChange={(changeEvent) => setPassword(changeEvent.target.value)}
          />
        </div>
        <div className="user-form-footer">
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={isInstanceAdmin}
              onChange={(changeEvent) => setIsInstanceAdmin(changeEvent.target.checked)}
            />
            Instance admin: manages Projects, Groups and users
          </label>
          <button type="submit" className="button button-primary" disabled={isChanging}>
            <PlusIcon size={14} />
            Create user
          </button>
        </div>
        <FormProblem problem={problem} />
      </form>
      <div className="table-scroll">
        <table className="data-table user-table">
          <thead>
            <tr>
              <th scope="col">User</th>
              <th scope="col" className="column-user-status">Status</th>
              <th scope="col" className="column-actions">
                <span className="visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr key={user.id} className={user.deactivatedAt === null ? "" : "user-deactivated"}>
                <td>
                  <span className="user-name">{user.displayName}</span>
                  <span className="user-email">{user.email}</span>
                </td>
                <td className="column-user-status">
                  {user.isInstanceAdmin && (
                    <span className="role-badge role-badge-admin">
                      <ShieldIcon size={11} />
                      Instance admin
                    </span>
                  )}
                  {user.deactivatedAt !== null && <span className="status-text">Deactivated</span>}
                </td>
                <td className="column-actions">
                  {user.id !== currentUser.id && (
                    <button
                      type="button"
                      className={user.deactivatedAt === null
                        ? "button button-ghost button-danger button-small"
                        : "button button-ghost button-small"}
                      disabled={isChanging}
                      aria-label={`${
                        user.deactivatedAt === null ? "Deactivate" : "Reactivate"
                      } ${user.displayName}`}
                      onClick={() =>
                        runChange(() =>
                          updateUser(credentials, user.id, {
                            isDeactivated: user.deactivatedAt === null,
                          })
                        )}
                    >
                      {user.deactivatedAt === null ? "Deactivate" : "Reactivate"}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
