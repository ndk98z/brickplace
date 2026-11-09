/// <reference types="vite/client" />

// Build-time settings. The deploy workflow passes them from the repository's GitHub Actions
// variables (ADR 0037); none has a default naming a real person, page or address.
interface ImportMetaEnv {
  /** WebSocket endpoint; defaults to /ws on the page's host. */
  readonly VITE_SOCKET_URL?: string;
  /** Who runs this copy of the game, as the legal pages name them. */
  readonly VITE_OPERATOR_NAME?: string;
  /** The operator's postal address, for the legal pages. */
  readonly VITE_OPERATOR_ADDRESS?: string;
  /** Contact address for legal, privacy and sponsor questions. */
  readonly VITE_CONTACT_EMAIL?: string;
  /** The repository the build was made from (AGPL-3.0 section 13). */
  readonly VITE_SOURCE_URL?: string;
  /** Ko-fi page, e.g. https://ko-fi.com/<page>. */
  readonly VITE_KOFI_URL?: string;
  /**
   * JSON array of { name, href, logo?, featured? }, at most 5 shown. `logo` is a same-origin
   * path such as /sponsors/acme.svg (put the file in apps/client/public/sponsors/).
   */
  readonly VITE_SPONSORS?: string;
  /** Page explaining how to become a sponsor. */
  readonly VITE_SPONSOR_INFO_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
