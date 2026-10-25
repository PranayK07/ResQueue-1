import { useEffect, useState } from 'react';
import { searchAddress, type Place } from '../lib/geo';
import { TextField } from './ui';
import './AddressField.css';

interface Props {
  /** Address text currently shown in the field. */
  value: string;
  onValueChange: (value: string) => void;
  /** Bias results toward this point (the current pin). */
  near: { lat: number; lon: number } | null;
  onChoose: (place: Place) => void;
}

/** Address input with debounced Photon suggestions. */
export function AddressField({ value, onValueChange, near, onChoose }: Props) {
  // Only text the user typed triggers a search, not text we fill in.
  const [typed, setTyped] = useState<string | null>(null);
  const [results, setResults] = useState<Place[]>([]);
  const [failed, setFailed] = useState(false);

  const nearLat = near?.lat;
  const nearLon = near?.lon;
  useEffect(() => {
    if (!typed || typed.trim().length < 3) return;
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      const bias = nearLat !== undefined && nearLon !== undefined ? { lat: nearLat, lon: nearLon } : null;
      searchAddress(typed, bias, ctrl.signal)
        .then(found => {
          setResults(found);
          setFailed(false);
        })
        .catch(() => {
          if (!ctrl.signal.aborted) setFailed(true);
        });
    }, 350);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [typed, nearLat, nearLon]);

  function choose(place: Place) {
    setTyped(null);
    setResults([]);
    onChoose(place);
  }

  const open = typed !== null && typed.trim().length >= 3 && (results.length > 0 || failed);

  return (
    <TextField
      id="address"
      label="Address"
      value={value}
      placeholder="Street address"
      onChange={v => {
        onValueChange(v);
        setTyped(v);
        setFailed(false);
        if (v.trim().length < 3) setResults([]);
      }}
      onKeyDown={e => {
        if (e.key === 'Enter' && open && results[0]) choose(results[0]);
        if (e.key === 'Escape') setTyped(null);
      }}
      inputProps={{ role: 'combobox', 'aria-expanded': open, 'aria-controls': 'address-results', 'aria-autocomplete': 'list' }}
    >
      {open && (
        <ul className="suggestions" id="address-results" role="listbox">
          {failed ? (
            <li className="suggestions__empty">Address search unavailable. Place the pin on the map instead.</li>
          ) : (
            results.map(r => (
              <li key={`${r.lat},${r.lon},${r.street}`} role="option" aria-selected={false}>
                <button type="button" onClick={() => choose(r)}>
                  <span className="suggestions__street">{r.street}</span>
                  <span className="suggestions__area">{r.area}</span>
                </button>
              </li>
            ))
          )}
        </ul>
      )}
    </TextField>
  );
}
