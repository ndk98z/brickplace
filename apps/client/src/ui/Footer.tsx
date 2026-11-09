import { CONTRIBUTORS_PAGE, EXTERNAL_REL, LEGAL, SOURCE_URL } from './links.ts';

/**
 * The Landing design's footer: legal pages, source, and the trademark disclaimer. The static
 * pages repeat this markup in their HTML (base.css styles both).
 */
export function Footer() {
  return (
    <footer class="site-footer">
      <div class="container site-footer-inner">
        <span class="site-footer-name">BrickPlace</span>
        <nav aria-label="Footer" class="site-footer-links">
          <a href={LEGAL.terms}>Terms</a>
          <a href={LEGAL.privacy}>Privacy</a>
          <a href={LEGAL.trademarks}>Trademarks</a>
          <a href={CONTRIBUTORS_PAGE}>Contributors</a>
          <a href={SOURCE_URL} rel={EXTERNAL_REL}>
            Source code (AGPL-3.0)
          </a>
        </nav>
        <span class="site-footer-note">Not affiliated with any block-game trademark holder.</span>
      </div>
    </footer>
  );
}
