import { addDay, dateSchema, minute, today, type TaskRecord } from './core';

export interface ReminderState {
  since: string | null;
  shownDays: string[];
  skippedDays: string[];
  snooze: {day:string;until:number} | null;
}
export const freshReminder = ():ReminderState => ({since:null,shownDays:[],skippedDays:[],snooze:null});

export function reviewDayAt(now:Date, timezone:string, target:string):string {
  minute(target);
  const time = new Intl.DateTimeFormat('en-GB',{timeZone:timezone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(now);
  const day=today(timezone,now);
  return minute(time) >= minute(target) ? day : addDay(day,-1);
}

export function shouldRemind(state:ReminderState, now:Date, timezone:string, target:string, completed:boolean, active:boolean):boolean {
  const day=reviewDayAt(now,timezone,target),calendarDay=today(timezone,now);
  if(!state.since || day < state.since || completed || !active || state.skippedDays.includes(day)) return false;
  if(state.snooze && state.snooze.day === day) return now.getTime() >= state.snooze.until;
  return !state.shownDays.includes(calendarDay);
}

export function markShown(state:ReminderState, now:Date, timezone:string):ReminderState {
  return {...state,shownDays:[...new Set([...state.shownDays,today(timezone,now)])].slice(-60),snooze:null};
}

export function skipReview(state:ReminderState, day:string):ReminderState {
  dateSchema.parse(day);
  return {...state,skippedDays:[...new Set([...state.skippedDays,day])].slice(-60),snooze:null};
}

export function snoozeReview(state:ReminderState, day:string, now:Date):ReminderState {
  dateSchema.parse(day);
  return {...state,snooze:{day,until:now.getTime()+60*60*1000}};
}

export function reviewActivity(records:TaskRecord[], day:string, timezone:string):boolean {
  return records.some(r => (r.task.status === 'open' && (!r.task.deferUntil || r.task.deferUntil <= day))
    || today(timezone,new Date(r.task.updated)) === day);
}
