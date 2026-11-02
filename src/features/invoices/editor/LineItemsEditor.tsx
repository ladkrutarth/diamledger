import React from 'react';
import { ArrowDown, ArrowUp, Copy, Plus, Sparkles, Trash2 } from 'lucide-react';
import type { DiamondItem } from '../../../types/invoice';
import { NumberField, TextField } from './fields';

const usd = (value: number) => `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const round2 = (value: number) => Math.round(value * 100) / 100;

let nextId = 0;
const newId = () => `item-${Date.now().toString(36)}-${(nextId += 1)}`;

/** A new line copies the description, HS code, and shape of the line above, which is usually what comes next. */
export function blankLine(previous: DiamondItem | undefined, srNo: number): DiamondItem {
  return {
    id: newId(),
    srNo,
    description: previous?.description ?? 'Cut & Polished Natural Diamonds',
    shape: previous?.shape ?? '',
    colorClarity: '',
    cutGrade: previous?.cutGrade ?? '',
    hsCode: previous?.hsCode ?? '7102.39.10',
    certificateNo: '',
    parcelId: '',
    pieces: 1,
    carats: 0,
    ratePerCarat: 0,
    totalAmount: 0,
  };
}

const renumber = (items: DiamondItem[]) => items.map((item, index) => ({ ...item, srNo: index + 1 }));

export const LineItemsEditor: React.FC<{
  items: DiamondItem[];
  onChange: (items: DiamondItem[]) => void;
  onReadManifest?: () => void;
}> = ({ items, onChange, onReadManifest }) => {
  const update = (index: number, patch: Partial<DiamondItem>) => {
    const next = items.map((item, i) => {
      if (i !== index) return item;
      const merged = { ...item, ...patch };
      // The line amount always follows carats × rate, to the cent, as the server requires.
      merged.totalAmount = round2((Number(merged.carats) || 0) * (Number(merged.ratePerCarat) || 0));
      return merged;
    });
    onChange(next);
  };
  const move = (index: number, by: -1 | 1) => {
    const target = index + by;
    if (target < 0 || target >= items.length) return;
    const next = [...items];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(renumber(next));
  };
  const duplicate = (index: number) => {
    const copy = { ...items[index], id: newId(), certificateNo: '' };
    onChange(renumber([...items.slice(0, index + 1), copy, ...items.slice(index + 1)]));
  };
  const remove = (index: number) => onChange(renumber(items.filter((_, i) => i !== index)));
  const add = () => onChange([...items, blankLine(items[items.length - 1], items.length + 1)]);

  const iconButton = 'rounded p-1 text-slate-500 hover:bg-slate-100 hover:text-slate-900 disabled:opacity-30 disabled:hover:bg-transparent';

  return (
    <div className="space-y-3">
      {items.length === 0 && (
        <div className="rounded-lg border border-dashed border-slate-300 p-6 text-center">
          <p className="text-sm text-slate-600">No lines yet.</p>
          <div className="mt-3 flex justify-center gap-2">
            <button type="button" onClick={add} className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white">
              <Plus className="h-3.5 w-3.5" /> Add a line
            </button>
            {onReadManifest && (
              <button type="button" onClick={onReadManifest} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold">
                <Sparkles className="h-3.5 w-3.5" /> Read from a manifest
              </button>
            )}
          </div>
        </div>
      )}

      {items.map((item, index) => (
        <div key={item.id || index} className="rounded-lg border border-slate-200 bg-slate-50/40">
          <div className="flex items-center justify-between gap-2 border-b border-slate-200 px-3 py-1.5">
            <span className="flex items-center gap-2 text-xs font-semibold text-slate-700">
              <span className="flex h-5 w-5 items-center justify-center rounded bg-slate-900 text-[10px] text-white">{index + 1}</span>
              {item.parcelId || 'No lot ID'}
            </span>
            <span className="flex items-center gap-1">
              <span className="mr-2 font-mono text-sm font-semibold tabular-nums text-slate-950">{usd(item.totalAmount)}</span>
              <button type="button" title="Move up" aria-label={`Move line ${index + 1} up`} disabled={index === 0} onClick={() => move(index, -1)} className={iconButton}>
                <ArrowUp className="h-3.5 w-3.5" />
              </button>
              <button type="button" title="Move down" aria-label={`Move line ${index + 1} down`} disabled={index === items.length - 1} onClick={() => move(index, 1)} className={iconButton}>
                <ArrowDown className="h-3.5 w-3.5" />
              </button>
              <button type="button" title="Duplicate" aria-label={`Duplicate line ${index + 1}`} onClick={() => duplicate(index)} className={iconButton}>
                <Copy className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                title="Delete"
                aria-label={`Delete line ${index + 1}`}
                onClick={() => remove(index)}
                className="rounded p-1 text-red-500 hover:bg-red-50 hover:text-red-700"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </span>
          </div>
          <div className="grid grid-cols-6 gap-x-3 gap-y-2 p-3">
            <TextField className="col-span-6" label="Description of goods" required field={`items.${index}.description`} value={item.description} onChange={(value) => update(index, { description: value })} />
            <NumberField className="col-span-2" label="Pieces" required integer field={`items.${index}.pieces`} value={item.pieces} onChange={(value) => update(index, { pieces: value })} />
            <NumberField className="col-span-2" label="Carats" required suffix="ct" field={`items.${index}.carats`} value={item.carats} onChange={(value) => update(index, { carats: value })} />
            <NumberField className="col-span-2" label="Rate per carat" required prefix="$" field={`items.${index}.ratePerCarat`} value={item.ratePerCarat} onChange={(value) => update(index, { ratePerCarat: value })} />
            <TextField className="col-span-2" label="Shape" placeholder="Round, Oval" value={item.shape} onChange={(value) => update(index, { shape: value })} />
            <TextField className="col-span-2" label="Colour / clarity" placeholder="G-H / VS" value={item.colorClarity} onChange={(value) => update(index, { colorClarity: value })} />
            <TextField className="col-span-2" label="Cut" placeholder="EX" value={item.cutGrade} onChange={(value) => update(index, { cutGrade: value })} />
            <TextField className="col-span-2" label="Certificate" placeholder="GIA 2489104821" mono field={`items.${index}.certificateNo`} value={item.certificateNo} onChange={(value) => update(index, { certificateNo: value })} />
            <TextField className="col-span-2" label="Parcel / lot" placeholder="LOT-101" mono field={`items.${index}.parcelId`} value={item.parcelId} onChange={(value) => update(index, { parcelId: value })} />
            <TextField className="col-span-2" label="HS code" required mono placeholder="7102.39.10" field={`items.${index}.hsCode`} value={item.hsCode} onChange={(value) => update(index, { hsCode: value })} />
          </div>
        </div>
      ))}

      {items.length > 0 && (
        <button
          type="button"
          onClick={add}
          className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-slate-300 py-2 text-xs font-semibold text-slate-700 hover:border-slate-900 hover:text-slate-950"
        >
          <Plus className="h-3.5 w-3.5" /> Add a line
        </button>
      )}
    </div>
  );
};
