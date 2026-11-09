import { Link } from "react-router";
import { ThemeSwitcher } from "../theme/theme-switcher.tsx";
import { LogOutIcon, ShieldIcon } from "../ui/icons.tsx";
import { usePopover } from "../ui/use-popover.ts";
import { useAccess } from "./access-context.ts";

/** The signed-in user's initials, opening their name, email and sign-out. */
export function UserMenu() {
  const { user, signOut } = useAccess();
  const { isOpen, setIsOpen, anchorRef } = usePopover();

  return (
    <div className="popover-anchor" ref={anchorRef}>
      <button
        type="button"
        className="user-menu-trigger"
        aria-expanded={isOpen}
        aria-haspopup="dialog"
        aria-label={`Account of ${user.displayName}`}
        title={user.email}
        onClick={() => setIsOpen(!isOpen)}
      >
        {readInitials(user.displayName)}
      </button>
      {isOpen && (
        <div className="popover" role="dialog" aria-label="Account">
          <div className="popover-section">
            <p className="popover-title">{user.displayName}</p>
            <p className="popover-text user-menu-email">{user.email}</p>
            {user.isInstanceAdmin && (
              <p className="popover-text user-menu-admin">
                <ShieldIcon size={13} />
                Instance admin
              </p>
            )}
          </div>
          <div className="popover-section user-menu-theme">
            <ThemeSwitcher />
          </div>
          <div className="popover-section">
            {user.isLocalAccount && (
              <Link
                className="button button-ghost button-block-start"
                to="/account"
                onClick={() => setIsOpen(false)}
              >
                Change password
              </Link>
            )}
            <button
              type="button"
              className="button button-ghost button-danger button-block-start"
              onClick={signOut}
            >
              <LogOutIcon size={14} />
              Sign out
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function readInitials(displayName: string): string {
  const nameParts = displayName.trim().split(/\s+/);
  return (nameParts[0][0] + (nameParts.length > 1 ? nameParts.at(-1)![0] : "")).toUpperCase();
}
