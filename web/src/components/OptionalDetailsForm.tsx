import { NEED_LABELS, formatDuration, type Details, type MediaItem, type Need } from '../lib/request';
import './OptionalDetailsForm.css';

const NEEDS = Object.keys(NEED_LABELS) as Need[];
const NOTE_MAX = 500; // submit_help_request rejects longer notes

function readVideoDuration(file: File): Promise<number | null> {
  return new Promise(resolve => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.preload = 'metadata';
    const done = (d: number | null) => {
      URL.revokeObjectURL(url);
      resolve(d);
    };
    video.onloadedmetadata = () => done(Number.isFinite(video.duration) ? video.duration : null);
    video.onerror = () => done(null);
    video.src = url;
  });
}

async function toMediaItem(file: File): Promise<MediaItem> {
  const kind = file.type.startsWith('video/') ? 'video' : 'photo';
  return {
    id: crypto.randomUUID(),
    name: file.name,
    kind,
    durationS: kind === 'video' ? await readVideoDuration(file) : null,
    status: 'local',
  };
}

interface Props {
  allowMedia?: boolean;
  idPrefix: string;
  value: Details;
  onChange: (next: Details) => void;
}

/** Headcount, needs, note and media. All of it stays on the device until sent. */
export function OptionalDetailsForm({ idPrefix, value, onChange, allowMedia = true }: Props) {
  const set = (patch: Partial<Details>) => onChange({ ...value, ...patch });

  return (
    <div className="details">
      <div className="details__row">
        <label className="details__label" htmlFor={`${idPrefix}-headcount`}>
          People at this location
        </label>
        <div className="stepper">
          <button
            type="button"
            aria-label="Fewer people"
            disabled={value.headcount <= 1}
            onClick={() => set({ headcount: value.headcount - 1 })}
          >
            −
          </button>
          <input
            id={`${idPrefix}-headcount`}
            type="number"
            inputMode="numeric"
            min={1}
            max={50}
            value={value.headcount}
            onChange={e => set({ headcount: Math.min(50, Math.max(1, Number(e.target.value) || 1)) })}
          />
          <button
            type="button"
            aria-label="More people"
            disabled={value.headcount >= 50}
            onClick={() => set({ headcount: value.headcount + 1 })}
          >
            +
          </button>
        </div>
      </div>

      <fieldset className="details__needs">
        <legend className="details__label">Needs</legend>
        {NEEDS.map(need => (
          <label key={need} className="chip">
            <input
              type="checkbox"
              checked={value.needs.includes(need)}
              onChange={e =>
                set({ needs: e.target.checked ? [...value.needs, need] : value.needs.filter(n => n !== need) })
              }
            />
            {NEED_LABELS[need].form}
          </label>
        ))}
      </fieldset>

      <div className="details__field">
        <label className="details__label" htmlFor={`${idPrefix}-note`}>
          Description
        </label>
        <textarea
          id={`${idPrefix}-note`}
          rows={3}
          maxLength={NOTE_MAX}
          placeholder="e.g. Side gate blocked. Use front entrance."
          value={value.note}
          onChange={e => set({ note: e.target.value })}
        />
      </div>

      {allowMedia && <div className="details__field">
        <span className="details__label">Photo or video</span>
        {value.media.length > 0 && (
          <ul className="details__media">
            {value.media.map(m => (
              <li key={m.id}>
                <span>
                  {m.name}
                  {m.durationS !== null && ` · ${formatDuration(m.durationS)}`}
                </span>
                <button type="button" onClick={() => set({ media: value.media.filter(x => x.id !== m.id) })}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
        <label className="details__attach">
          Add photo or video
          <input
            type="file"
            accept="image/*,video/*"
            multiple
            onChange={async e => {
              const files = [...(e.target.files ?? [])];
              e.target.value = '';
              if (files.length) set({ media: [...value.media, ...(await Promise.all(files.map(toMediaItem)))] });
            }}
          />
        </label>
        <p className="details__hint">Media uploads separately and never blocks the help alert.</p>
      </div>}
    </div>
  );
}
