import React from 'react';

interface SimpleSearchProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}

export function SimpleSearch({ value, onChange, placeholder = '搜尋...' }: SimpleSearchProps) {
  return (
    <div className="simple-search">
      <input
        type="text"
        className="search-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
    </div>
  );
}