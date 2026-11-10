/** The header a Target's credential travels in. The value is never shown again once saved. */
export interface CredentialDraft {
  headerName: string;
  headerValue: string;
}

export const NEW_CREDENTIAL_DRAFT: CredentialDraft = {
  headerName: "Authorization",
  headerValue: "",
};

export function CredentialFields(
  { idPrefix, draft, valuePlaceholder, onChange }: {
    idPrefix: string;
    draft: CredentialDraft;
    valuePlaceholder: string;
    onChange: (draft: CredentialDraft) => void;
  },
) {
  return (
    <div className="form-field-row">
      <div className="form-field">
        <label className="field-label" htmlFor={`${idPrefix}-header-name`}>Credential header</label>
        <input
          id={`${idPrefix}-header-name`}
          className="text-input text-input-mono"
          autoComplete="off"
          spellCheck={false}
          value={draft.headerName}
          onChange={(changeEvent) => onChange({ ...draft, headerName: changeEvent.target.value })}
        />
      </div>
      <div className="form-field">
        <label className="field-label" htmlFor={`${idPrefix}-header-value`}>Credential value</label>
        <input
          id={`${idPrefix}-header-value`}
          className="text-input text-input-mono"
          type="password"
          autoComplete="new-password"
          spellCheck={false}
          placeholder={valuePlaceholder}
          value={draft.headerValue}
          onChange={(changeEvent) => onChange({ ...draft, headerValue: changeEvent.target.value })}
        />
      </div>
    </div>
  );
}
