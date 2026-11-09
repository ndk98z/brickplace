import { fetchSiteInfo } from '../config.ts';
import { CONTRIBUTORS, ROLE_NAMES, type Role } from './contributors-list.ts';
import {
  type Filter,
  filtered,
  initialOf,
  kofiLink,
  personUrl,
  sponsorLink,
  sponsorsOf,
} from './support.ts';

// The Contributors design: people from the static list with a role filter, ways to help, and
// the sponsors (same-origin logos only, see config.ts) with the Ko-fi and sponsor links.

const TINTS = ['#FFE0D6', '#E5EEFF', '#FFF1A8', '#E8F7EF', '#F1EDFF', '#FFE0F0'];

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<Record<string, string>> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value !== undefined) node.setAttribute(key, value);
  }
  node.append(...children);
  return node;
}

function renderPeople(list: HTMLElement, filter: Filter): void {
  const people = filtered(CONTRIBUTORS, filter);
  list.replaceChildren(
    ...people.map((person, i) => {
      const url = personUrl(person);
      const name = url
        ? el('a', { href: url, rel: 'noopener noreferrer' }, person.name)
        : person.name;
      return el(
        'li',
        { class: 'person' },
        el(
          'span',
          {
            class: 'person-avatar',
            'aria-hidden': 'true',
            style: `background:${TINTS[i % TINTS.length]}`,
          },
          initialOf(person.name),
        ),
        el('strong', {}, name),
        el(
          'span',
          { class: 'tags' },
          ...person.roles.map((role) => el('span', { class: `tag tag-${role}` }, ROLE_NAMES[role])),
        ),
      );
    }),
  );
  if (people.length === 0) list.append(el('li', { class: 'fine' }, 'Nobody in this role yet.'));
}

function setupPeople(): void {
  const list = document.querySelector<HTMLElement>('#people');
  const filters = document.querySelector<HTMLElement>('#filters');
  const count = document.querySelector<HTMLElement>('#count');
  if (!list || !filters) return;
  if (count) count.textContent = String(CONTRIBUTORS.length);
  const options: Filter[] = ['all', ...(Object.keys(ROLE_NAMES) as Role[])];
  const buttons = options.map((option) => {
    const button = el(
      'button',
      { type: 'button', 'aria-pressed': String(option === 'all') },
      option === 'all' ? 'All' : ROLE_NAMES[option],
    );
    button.addEventListener('click', () => {
      for (const b of buttons) b.setAttribute('aria-pressed', String(b === button));
      renderPeople(list, option);
    });
    return button;
  });
  filters.replaceChildren(...buttons);
  renderPeople(list, 'all');
}

function sponsorLogo(name: string, logo: string | undefined): Node {
  // Same-origin logos only (config.ts); the name stands in when there is none.
  return logo ? el('img', { src: logo, alt: name }) : document.createTextNode(name);
}

async function setupSponsors(): Promise<void> {
  const env = import.meta.env;
  // The admin area's sponsors and links (ADR 0038); the build's while the gateway is out.
  const site = await fetchSiteInfo();
  const { featured, others } = sponsorsOf(env, site);
  const main = document.querySelector<HTMLElement>('#sponsor-main');
  if (main && featured) {
    main.replaceChildren(
      el('span', { class: 'sponsor-kicker' }, 'Season sponsor · shown on the map'),
      el(
        'a',
        { href: featured.href, rel: 'noopener noreferrer sponsored' },
        sponsorLogo(featured.name, featured.logo),
      ),
    );
  }
  const supporters = document.querySelector<HTMLElement>('#supporters');
  if (supporters && others.length > 0) {
    supporters.replaceChildren(
      ...others.map((s) =>
        el(
          'a',
          { class: 'supporter', href: s.href, rel: 'noopener noreferrer sponsored' },
          sponsorLogo(s.name, s.logo),
        ),
      ),
    );
  }
  // The page is built with the build's links (vite.config.ts); this points them at the admin
  // area's and drops those left unset.
  for (const [id, href] of [
    ['#kofi', kofiLink(env, site)],
    ['#become', sponsorLink(env, site)],
  ] as const) {
    const link = document.querySelector(id);
    if (!href) link?.remove();
    else link?.setAttribute('href', href);
  }
}

setupPeople();
void setupSponsors();
