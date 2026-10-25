import type { ButtonHTMLAttributes, ReactNode } from 'react';
import brandMark from '../assets/figma/brand-mark.svg';
import type { CallerLocation } from '../lib/request';
import './ui.css';

/** Mobile frame shared by every caller screen: product identity bar + content. */
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="screen">
      <header className="identity">
        <img className="identity__mark" src={brandMark} width={15} height={20} alt="" />
        <span className="identity__name">ResQueue</span>
        <a className="badge badge--simulation identity__switch" href="#/responder">
          View responder screen
        </a>
      </header>
      <main className="screen__content">{children}</main>
    </div>
  );
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' };

export function Button({ variant = 'secondary', className = '', ...rest }: ButtonProps) {
  return <button type="button" className={`button button--${variant} ${className}`} {...rest} />;
}

export function Heading({ children }: { children: ReactNode }) {
  return <h1 className="heading">{children}</h1>;
}

export function Eyebrow({ children }: { children: ReactNode }) {
  return <p className="eyebrow">{children}</p>;
}

export function Note({ children, tone = 'muted', size = 12 }: { children: ReactNode; tone?: 'muted' | 'ink'; size?: 11 | 12 | 13 | 14 | 16 }) {
  return <p className={`note note--${tone} note--${size}`}>{children}</p>;
}

/** Amber callout (Figma "Status notice"). */
export function StatusNotice({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <div className="notice" role="status">
      <p className="notice__title">{title}</p>
      <p className="notice__body">{children}</p>
    </div>
  );
}

/** White bordered card (Figma "Content panel"). */
export function Panel({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`panel ${className}`}>{children}</div>;
}

export function LocationBlock({ label, location }: { label: string; location: CallerLocation }) {
  return (
    <div className="location">
      <p className="location__label">{label}</p>
      <p className="location__street">{location.street}</p>
      <p className="location__area">{location.area}</p>
      {location.entrance && <p className="location__area">Entrance: {location.entrance}</p>}
    </div>
  );
}

export function SafetyNotice() {
  return (
    <div className="safety">
      <p className="safety__call">
        Immediate danger? <a href="tel:911">Call 911</a>
      </p>
      <p className="safety__sim">Simulated assistance only · No real dispatch</p>
    </div>
  );
}

interface TextFieldProps {
  id: string;
  label: string;
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  /** Rendered under the input, e.g. address suggestions. */
  children?: ReactNode;
  inputProps?: React.InputHTMLAttributes<HTMLInputElement>;
}

/** Labelled text input with a "Clear" action (Figma "Input field"). */
export function TextField({ id, label, value, placeholder, onChange, onKeyDown, children, inputProps }: TextFieldProps) {
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      <div className="field__wrap">
        <div className="field__input">
          <input
            id={id}
            value={value}
            placeholder={placeholder}
            autoComplete="off"
            onChange={e => onChange(e.target.value)}
            onKeyDown={onKeyDown}
            {...inputProps}
          />
          {value && (
            <button type="button" className="field__clear" onClick={() => onChange('')} aria-label={`Clear ${label}`}>
              Clear
            </button>
          )}
        </div>
        {children}
      </div>
    </div>
  );
}

const STAGES = ['Received', 'Assigned', 'En route'] as const;

/** ✓ Received  ● Assigned  ○ En route */
export function RequestProgress({ current }: { current: (typeof STAGES)[number] }) {
  const at = STAGES.indexOf(current);
  return (
    <ol className="progress" aria-label="Request progress">
      {STAGES.map((stage, i) => (
        <li key={stage} className={i === at ? 'progress__stage progress__stage--current' : 'progress__stage'} aria-current={i === at ? 'step' : undefined}>
          {i < at ? '✓' : i === at ? '●' : '○'} {stage}
        </li>
      ))}
    </ol>
  );
}
