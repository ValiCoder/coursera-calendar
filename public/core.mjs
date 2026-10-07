export const DAY = 86400000;
export const clone = value => structuredClone(value);
export function localDay(value, plan) {
  return Math.floor((new Date(value).getTime() + plan.TimeZoneOffsetMinutes * 60000) / DAY);
}
export const dayISO = day => new Date(day * DAY).toISOString().slice(0, 10);
export function planTrackStart(plan, state, trackId) {
  return state.TrackPlanStart?.[trackId] ? Math.floor(Date.parse(state.TrackPlanStart[trackId]) / DAY) : localDay(state.TrackStarted[trackId], plan);
}
export function courseDays(course, plan) { return Math.ceil(course.Hours / plan.StudyHoursPerDay); }
export function activeCourse(plan, state, trackId) {
  return plan.Courses.find(c => c.TrackId === trackId && !state.CourseCompleted[c.Id]);
}
export function earliestFinish(plan, state, trackId) {
  const track = plan.Tracks.find(t => t.Id === trackId);
  const days = plan.Courses.filter(c => c.TrackId === trackId).reduce((a, c) => a + courseDays(c, plan), 0);
  return planTrackStart(plan, state, trackId) + Math.max(track.MinimumDays, days) + track.ReserveDays - 1;
}
export function pending(plan, state, course, now) {
  if (activeCourse(plan, state, course.TrackId)?.Id !== course.Id) return true;
  let ready = planTrackStart(plan, state, course.TrackId) * DAY - plan.TimeZoneOffsetMinutes * 60000;
  for (const c of plan.Courses) if (c.TrackId === course.TrackId && state.CourseCompleted[c.Id]) ready = Math.max(ready, new Date(state.CourseCompleted[c.Id]).getTime());
  if (state.CourseStarted[course.Id]) ready = Math.max(ready, new Date(state.CourseStarted[course.Id]).getTime());
  if (state.CoursePlanStart?.[course.Id]) ready = Math.max(ready, Date.parse(state.CoursePlanStart[course.Id]) - plan.TimeZoneOffsetMinutes * 60000);
  return now.getTime() < ready;
}
export function activate(plan, state, now) {
  let changed = false;
  for (const t of plan.Tracks) {
    const c = activeCourse(plan, state, t.Id);
    if (c && !state.CourseStarted[c.Id] && !pending(plan, state, c, now)) {
      const previous = plan.Courses.filter(x => x.TrackId === t.Id && state.CourseCompleted[x.Id]).map(x => new Date(state.CourseCompleted[x.Id]).getTime());
      const planned = Date.parse(state.CoursePlanStart?.[c.Id] || dayISO(planTrackStart(plan, state, t.Id))) - plan.TimeZoneOffsetMinutes * 60000;
      state.CourseStarted[c.Id] = new Date(Math.max(planned, ...previous)).toISOString();
      changed = true;
    }
  }
  return changed;
}
export function buildSchedule(plan, state, now = new Date()) {
  const today = localDay(now, plan);
  const tracks = plan.Tracks.map(track => {
    const start = planTrackStart(plan, state, track.Id);
    const earliest = earliestFinish(plan, state, track.Id);
    let boundary = start;
    const active = activeCourse(plan, state, track.Id);
    const courses = plan.Courses.filter(c => c.TrackId === track.Id).map(course => {
      const completed = state.CourseCompleted[course.Id];
      const savedStart = state.CourseStarted[course.Id];
      const isActive = active?.Id === course.Id;
      let begin = completed ? localDay(savedStart, plan) : state.CoursePlanStart?.[course.Id] ? Math.floor(Date.parse(state.CoursePlanStart[course.Id]) / DAY) : savedStart ? localDay(savedStart, plan) : boundary;
      if (isActive && !completed) begin = Math.max(begin, start);
      if (isActive && !savedStart) begin = Math.max(begin, today);
      let end = completed ? localDay(completed, plan) : begin + courseDays(course, plan) - 1;
      const isLast = plan.Courses.filter(c => c.TrackId === track.Id).at(-1).Id === course.Id;
      if (isActive && !completed && end < today && !(isLast && today <= earliest)) end = today;
      boundary = Math.max(boundary, end + 1);
      const status = completed ? 'completed' : isActive && !pending(plan, state, course, now) ? (today > begin + courseDays(course, plan) - 1 && !(isLast && today <= earliest) ? 'overdue' : 'active') : 'planned';
      const dayIndex = today - begin;
      const hoursToday = !completed && dayIndex >= 0 && dayIndex < courseDays(course, plan) ? Math.min(plan.StudyHoursPerDay, course.Hours - dayIndex * plan.StudyHoursPerDay) : 0;
      return { ...course, start: begin, end, status, days: courseDays(course, plan), hoursToday, progress: completed ? 100 : state.Progress?.[course.Id] || 0, active: isActive, canComplete: isActive && !pending(plan, state, course, now) && !(isLast && today < earliest), completedAt: completed || null };
    });
    const studyEnd = Math.max(start, ...courses.map(c => c.end));
    const finished = courses.every(c => c.status === 'completed');
    const baselineStudyEnd = earliest - track.ReserveDays;
    const reserveStart = Math.max(studyEnd, baselineStudyEnd) + 1;
    return { ...track, start, end: finished ? studyEnd : reserveStart + track.ReserveDays - 1, earliest, studyEnd, waitStart: studyEnd < baselineStudyEnd ? studyEnd + 1 : null, waitEnd: baselineStudyEnd, reserveStart, finished, courses };
  });
  return { today, start: Math.min(...tracks.map(t => t.start), ...tracks.flatMap(t => t.courses.map(c => c.start))), end: Math.max(...tracks.map(t => t.end)), tracks };
}
export function completeCourse(plan, state, id, now = new Date()) {
  const course = plan.Courses.find(c => c.Id === id);
  if (!course) throw new Error('Неизвестный модуль.');
  if (state.CourseCompleted[id]) throw new Error('Этот модуль уже пройден.');
  if (activeCourse(plan, state, course.TrackId)?.Id !== id) throw new Error('Сначала завершите предыдущий модуль этого предмета.');
  if (pending(plan, state, course, now)) throw new Error('Дата начала этого предмета ещё не наступила.');
  activate(plan, state, now);
  if (now.getTime() < new Date(state.CourseStarted[id]).getTime()) throw new Error('Дата компьютера раньше сохранённого начала курса.');
  const remaining = plan.Courses.filter(c => c.TrackId === course.TrackId && !state.CourseCompleted[c.Id]);
  if (remaining.length === 1 && localDay(now, plan) < earliestFinish(plan, state, course.TrackId)) throw new Error('Завершение предмета доступно с ' + dayISO(earliestFinish(plan, state, course.TrackId)) + ': соблюдаем минимальный срок и запас.');
  state.CourseCompleted[id] = now.toISOString();
  state.Progress[id] = 100;
  const next = activeCourse(plan, state, course.TrackId);
  if (next && !state.CourseStarted[next.Id]) state.CourseStarted[next.Id] = now.toISOString();
  if (next) { state.CoursePlanStart ||= {}; state.CoursePlanStart[next.Id] = dayISO(localDay(now, plan)); }
  state.SelectedId = next?.Id || id;
  return next;
}
export function reschedule(plan, state, date, trackId = null) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0,10) !== date || date < '2020-01-01' || date > '2100-12-31') throw new Error('Укажите корректную дату начала.');
  const tracks = trackId ? plan.Tracks.filter(t => t.Id === trackId) : plan.Tracks;
  if (!tracks.length) throw new Error('Неизвестный предмет.');
  state.TrackPlanStart ||= {}; state.CoursePlanStart ||= {};
  for (const track of tracks) {
    if (!activeCourse(plan, state, track.Id)) continue;
    const oldStart = planTrackStart(plan, state, track.Id);
    const newStart = Math.floor(Date.parse(date) / DAY);
    const delta = newStart - oldStart;
    const active = activeCourse(plan, state, track.Id);
    if (active) {
      const previousStart = state.CoursePlanStart[active.Id] ? Math.floor(Date.parse(state.CoursePlanStart[active.Id]) / DAY) : state.CourseStarted[active.Id] ? localDay(state.CourseStarted[active.Id], plan) : oldStart;
      state.CoursePlanStart[active.Id] = dayISO(previousStart + delta);
    }
    state.TrackPlanStart[track.Id] = date;
  }
}
export function reminderOrder(plan) {
  const groups = plan.Tracks.map(t => plan.Courses.filter(c => c.TrackId === t.Id));
  return Array.from({length: Math.max(...groups.map(g => g.length))}, (_, i) => groups.map(g => g[i]).filter(Boolean)).flat();
}
export function reminderTarget(plan, state, now = new Date()) {
  const order = reminderOrder(plan);
  for (let offset = 0; offset < order.length; offset++) {
    const position = (state.ReminderCursor + offset) % order.length;
    const course = order[position];
    if (!state.CourseCompleted[course.Id] && !pending(plan, state, course, now)) return {course, position, count: order.length};
  }
  return null;
}
export function validateState(plan, state) {
  const ids = new Set(plan.Courses.map(c => c.Id));
  const timestamp = v => typeof v === 'string' && Number.isFinite(Date.parse(v));
  if (state.SchemaVersion !== 1 || !ids.has(state.SelectedId) || !Number.isInteger(state.ReminderCursor) || state.ReminderCursor < 0 || state.ReminderCursor >= plan.Courses.length) throw new Error('Повреждён файл прогресса. Данные сохранены; проверьте резервную копию.');
  for (const map of ['TrackStarted', 'CourseStarted', 'CourseCompleted', 'Progress']) if (!state[map] || typeof state[map] !== 'object' || Array.isArray(state[map])) throw new Error('Некорректный файл прогресса: ' + map);
  for (const t of plan.Tracks) {
    if (!timestamp(state.TrackStarted[t.Id])) throw new Error('Нет корректной даты начала предмета.');
    let incomplete = false;
    let previous = -Infinity;
    const courses = plan.Courses.filter(c => c.TrackId === t.Id);
    for (const c of courses) {
      const done = state.CourseCompleted[c.Id];
      const start = state.CourseStarted[c.Id];
      if (start && (!timestamp(start) || Date.parse(start) < previous)) throw new Error('Некорректная дата начала курса.');
      if (!done) { incomplete = true; continue; }
      if (incomplete || !timestamp(done) || !start || Date.parse(done) < Date.parse(start)) throw new Error('Нарушен порядок завершения модулей.');
      previous = Date.parse(done);
    }
    if (courses.every(c => state.CourseCompleted[c.Id]) && localDay(state.CourseCompleted[courses.at(-1).Id], plan) < earliestFinish(plan, state, t.Id)) throw new Error('Нарушен минимальный срок предмета.');
  }
  for (const map of ['CourseStarted', 'CourseCompleted']) for (const [id, v] of Object.entries(state[map])) if (!ids.has(id) || !timestamp(v)) throw new Error('Неизвестный модуль или неверная дата.');
  for (const [id, v] of Object.entries(state.Progress)) if (!ids.has(id) || !Number.isInteger(v) || v < 0 || v > 100) throw new Error('Неверный процент прогресса.');
  for (const key of ['NextNotificationUtc', 'SnoozeUtc']) if (state[key] && !timestamp(state[key])) throw new Error('Неверная дата напоминания.');
  for (const map of ['TrackPlanStart','CoursePlanStart']) for (const [id, date] of Object.entries(state[map] || {})) {
    if (!(map === 'TrackPlanStart' ? plan.Tracks.some(t => t.Id === id) : ids.has(id)) || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0,10) !== date) throw new Error('Некорректная дата плана.');
  }
  if (state.Program && !['technological','general'].includes(state.Program)) throw new Error('Неизвестная программа предпринимательства.');
  return state;
}
