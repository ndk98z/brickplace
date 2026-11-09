// Line icons from the approved design (24 x 24 viewBox).

interface IconProps {
  readonly size?: number;
  readonly color?: string;
}

export function HammerIcon({ size = 30, color = '#171B26' }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      stroke-width="2"
      stroke-linejoin="round"
      stroke-linecap="round"
      aria-hidden="true"
    >
      <path d="M13 5l6 6-3 3-6-6z" />
      <path d="M11.5 9.5L4 17l3 3 7.5-7.5" />
    </svg>
  );
}

export function ShieldIcon({ size = 30, color = '#1F4FB8' }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      stroke-width="2"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M12 3l7 3v5c0 5-3 8.5-7 10-4-1.5-7-5-7-10V6z" />
    </svg>
  );
}

export function RotateIcon({ size = 15, color = '#FFFFFF' }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      stroke-width="2.2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M20 12a8 8 0 1 1-2.4-5.7" />
      <path d="M20 4v5h-5" />
    </svg>
  );
}

export function HeartIcon({ size = 15, color = '#171B26' }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      stroke-width="2.2"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z" />
    </svg>
  );
}

export function PlusIcon({ size = 20, color = '#171B26' }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      stroke-width="2.2"
      stroke-linecap="round"
      aria-hidden="true"
    >
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

export function MinusIcon({ size = 20, color = '#171B26' }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      stroke-width="2.2"
      stroke-linecap="round"
      aria-hidden="true"
    >
      <path d="M5 12h14" />
    </svg>
  );
}

export function CameraIcon({ size = 20, color = '#171B26' }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      stroke-width="2"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M4 8h3l2-3h6l2 3h3v11H4z" />
      <circle cx="12" cy="13" r="3.5" />
    </svg>
  );
}

export function FlagIcon({ size = 20, color = '#171B26' }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      stroke-width="2"
      stroke-linejoin="round"
      stroke-linecap="round"
      aria-hidden="true"
    >
      <path d="M5 21V4h12l-2 4 2 4H5" />
    </svg>
  );
}
