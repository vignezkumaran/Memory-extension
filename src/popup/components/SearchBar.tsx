import { useId, type ReactElement } from 'react';

interface SearchBarProps {
  value: string;
  onChange: (value: string) => void;
}

export function SearchBar({ value, onChange }: SearchBarProps): ReactElement {
  const id = useId();

  return (
    <div className="ai-search-wrap">
      <label htmlFor={id} style={{ display: 'none' }}>
        Search memories
      </label>
      <input
        className="ai-input"
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Search memories..."
      />
    </div>
  );
}
