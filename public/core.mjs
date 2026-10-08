export const DAY = 86400000;
export const clone = value => structuredClone(value);
export function localDay(value, plan) {
  return Math.floor((new Date(value).getTime() + plan.TimeZoneOffsetMinutes * 60000) / DAY);
}
export const dayISO = day => new Date(day * DAY).toISOString().slice(0, 10);
const importantDateLabels = {
  SubscriptionEndDate: 'окончания подписки Coursera',
  ApplicationStartDate: 'начала подачи заявки',
  ApplicationEndDate: 'окончания подачи заявки'
};
function validImportantDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && value >= '2020-01-01' && value <= '2100-12-31' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
function resolveImportantDates(plan, state) {
  const dates = {};
  for (const field of Object.keys(importantDateLabels)) {
    const value = state[field] === undefined ? plan[field] ?? null : state[field];
    if (value !== null && !validImportantDate(value)) throw new Error('Укажите корректную дату ' + importantDateLabels[field] + '.');
    dates[field] = value;
  }
  const start = dates.ApplicationStartDate, end = dates.ApplicationEndDate;
  if ((start === null) !== (end === null)) throw new Error('Укажите обе даты подачи заявки или очистите обе.');
  if (start !== null && start > end) throw new Error('Начало подачи заявки не может быть позже окончания.');
  return dates;
}
export function importantDates(plan, state, now = new Date()) {
  const dates = resolveImportantDates(plan, state), today = localDay(now, plan);
  const toDay = value => value === null ? null : Math.floor(Date.parse(value) / DAY);
  const subscriptionEndDay = toDay(dates.SubscriptionEndDate);
  const applicationStartDay = toDay(dates.ApplicationStartDate), applicationEndDay = toDay(dates.ApplicationEndDate);
  const applicationStatus = applicationStartDay === null ? null : today < applicationStartDay ? 'upcoming' : today <= applicationEndDay ? 'open' : 'closed';
  return {
    subscriptionEndDay, applicationStartDay, applicationEndDay,
    subscriptionRemainingDays: subscriptionEndDay === null ? null : subscriptionEndDay - today,
    applicationStatus,
    applicationRemainingDays: applicationStatus === null ? null : applicationStatus === 'upcoming' ? applicationStartDay - today : applicationStatus === 'open' ? applicationEndDay - today + 1 : 0
  };
}
export function planTrackStart(plan, state, trackId) {
  return state.TrackPlanStart?.[trackId] ? Math.floor(Date.parse(state.TrackPlanStart[trackId]) / DAY) : localDay(state.TrackStarted[trackId], plan);
}
export function courseDays(course, plan) { return Math.ceil(course.Hours / plan.StudyHoursPerDay); }
export function trackCourses(plan, state, trackId) {
  const courses = plan.Courses.filter(c => c.TrackId === trackId);
  const order = state.CourseOrder?.[trackId];
  if (!order) return courses;
  const positions = new Map(order.map((id, i) => [id, i]));
  return courses.toSorted((a, b) => (positions.get(a.Id) ?? Infinity) - (positions.get(b.Id) ?? Infinity));
}
export function initializeCoursePlan(plan, state) {
  state.CoursePlanStart = {};
  for (const track of plan.Tracks) {
    let day = planTrackStart(plan, state, track.Id);
    for (const course of plan.Courses.filter(c => c.TrackId === track.Id)) {
      state.CoursePlanStart[course.Id] = dayISO(day);
      day += courseDays(course, plan);
    }
  }
}
export function migrateState(plan, state) {
  let changed = false;
  if (state.SchemaVersion === 1) {
    initializeCoursePlan(plan, state);
    state.ProgressBeforeComplete = {};
    state.SchemaVersion = 2;
    changed = true;
  }
  if (![2, 3, 4].includes(state.SchemaVersion)) throw new Error('Неизвестная версия профиля. Данные сохранены.');
  if ((state.CatalogRevision || 0) < (plan.CatalogRevision || 0)) {
    const additions = plan.Courses.filter(c => (c.AddedInCatalogRevision || 0) > (state.CatalogRevision || 0));
    const addedIds = new Set(additions.map(c => c.Id));
    state.CoursePlanStart ||= {};
    state.CourseOrder ||= {};
    for (const track of plan.Tracks) {
      const added = additions.filter(c => c.TrackId === track.Id);
      if (!added.length) continue;
      const previous = trackCourses(plan, state, track.Id).filter(c => !addedIds.has(c.Id));
      let boundary = planTrackStart(plan, state, track.Id);
      for (const course of previous) {
        const start = state.CoursePlanStart[course.Id] ? Math.floor(Date.parse(state.CoursePlanStart[course.Id]) / DAY) : boundary;
        boundary = Math.max(boundary, start + courseDays(course, plan));
      }
      const cutoff = plan.ReorderAfterDate ? Math.floor(Date.parse(plan.ReorderAfterDate) / DAY) + 1 : boundary;
      let cursor = Math.max(boundary, cutoff);
      for (const course of added) {
        const existing = state.CoursePlanStart[course.Id] ? Math.floor(Date.parse(state.CoursePlanStart[course.Id]) / DAY) : cursor;
        const start = Math.max(cursor, existing);
        state.CoursePlanStart[course.Id] = dayISO(start);
        cursor = start + courseDays(course, plan);
      }
      state.CourseOrder[track.Id] = [...previous.map(c => c.Id), ...added.map(c => c.Id)];
    }
    state.CatalogRevision = plan.CatalogRevision;
    changed = true;
  }
  if ((state.PlanningRevision || 0) < (plan.PlanningRevision || 0)) {
    const cutoff = Math.floor(Date.parse(plan.ReorderAfterDate) / DAY);
    if (!Number.isFinite(cutoff)) throw new Error('Не задана дата обновления плана.');
    state.CourseOrder ||= {};
    state.CoursePlanStart ||= {};
    for (const track of plan.Tracks) {
      const previous = trackCourses(plan, state, track.Id);
      const desired = plan.FutureCourseOrder?.[track.Id] || previous.map(c => c.Id);
      if (new Set(desired).size !== previous.length || desired.length !== previous.length || previous.some(c => !desired.includes(c.Id))) throw new Error('Неполный порядок курсов предмета.');
      let baseline = planTrackStart(plan, state, track.Id);
      const starts = new Map(previous.map(course => {
        const start = state.CoursePlanStart[course.Id] ? Math.floor(Date.parse(state.CoursePlanStart[course.Id]) / DAY) : baseline;
        baseline = Math.max(baseline, start + courseDays(course, plan));
        return [course.Id, start];
      }));
      // Preserve whole bars that touch the protected period, including their end.
      // Completed bars keep their ranges even when they were finished early.
      const frozen = previous.filter(c => starts.get(c.Id) <= cutoff || state.CourseCompleted[c.Id] || state.CourseStarted[c.Id] && localDay(state.CourseStarted[c.Id], plan) <= cutoff);
      const frozenIds = new Set(frozen.map(c => c.Id));
      const future = desired.filter(id => !frozenIds.has(id));
      let cursor = Math.max(planTrackStart(plan, state, track.Id), cutoff + 1, ...frozen.map(c => starts.get(c.Id) + courseDays(c, plan)));
      for (const course of frozen) state.CoursePlanStart[course.Id] = dayISO(starts.get(course.Id));
      for (const id of future) {
        state.CoursePlanStart[id] = dayISO(cursor);
        cursor += courseDays(previous.find(c => c.Id === id), plan);
      }
      state.CourseOrder[track.Id] = [...frozen.map(c => c.Id), ...future];
    }
    state.PlanningRevision = plan.PlanningRevision;
    changed = true;
  }
  if (state.SchemaVersion !== 4) { state.SchemaVersion = 4; changed = true; }
  return changed;
}
export function activeCourse(plan, state, trackId) {
  return trackCourses(plan, state, trackId).find(c => !state.CourseCompleted[c.Id] && !state.DeferredCourses?.[c.Id]);
}
export function earliestFinish(plan, state, trackId) {
  const track = plan.Tracks.find(t => t.Id === trackId);
  const days = plan.Courses.filter(c => c.TrackId === trackId).reduce((a, c) => a + courseDays(c, plan), 0);
  return planTrackStart(plan, state, trackId) + Math.max(track.MinimumDays, days) + track.ReserveDays - 1;
}
export function pending(plan, state, course, now) {
  if (state.DeferredCourses?.[course.Id]) return true;
  if (activeCourse(plan, state, course.TrackId)?.Id !== course.Id) return true;
  let ready = planTrackStart(plan, state, course.TrackId) * DAY - plan.TimeZoneOffsetMinutes * 60000;
  if (state.CourseStarted[course.Id]) ready = Math.max(ready, new Date(state.CourseStarted[course.Id]).getTime());
  return now.getTime() < ready;
}
export function activate(plan, state, now) {
  let changed = false;
  for (const t of plan.Tracks) {
    const c = activeCourse(plan, state, t.Id);
    if (c && !state.CourseStarted[c.Id] && !pending(plan, state, c, now)) {
      const previous = plan.Courses.filter(x => x.TrackId === t.Id && state.CourseCompleted[x.Id]).map(x => new Date(state.CourseCompleted[x.Id]).getTime());
      const planned = planTrackStart(plan, state, t.Id) * DAY - plan.TimeZoneOffsetMinutes * 60000;
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
    const courses = trackCourses(plan, state, track.Id).map(course => {
      const completed = state.CourseCompleted[course.Id];
      const isActive = active?.Id === course.Id;
      const begin = state.CoursePlanStart?.[course.Id] ? Math.floor(Date.parse(state.CoursePlanStart[course.Id]) / DAY) : boundary;
      const end = begin + courseDays(course, plan) - 1;
      const completesTrack = plan.Courses.filter(c => c.TrackId === track.Id && !state.CourseCompleted[c.Id] && !state.DeferredCourses?.[c.Id]).length === 1;
      boundary = Math.max(boundary, end + 1);
      const status = completed ? 'completed' : state.DeferredCourses?.[course.Id] ? 'deferred' : isActive && !pending(plan, state, course, now) ? (today > end && !(completesTrack && today <= earliest) ? 'overdue' : 'active') : 'planned';
      const dayIndex = today - begin;
      const hoursToday = !completed && !state.DeferredCourses?.[course.Id] && dayIndex >= 0 && dayIndex < courseDays(course, plan) ? Math.min(plan.StudyHoursPerDay, course.Hours - dayIndex * plan.StudyHoursPerDay) : 0;
      return { ...course, start: begin, end, status, days: courseDays(course, plan), hoursToday, progress: completed ? 100 : state.Progress?.[course.Id] || 0, active: isActive, canComplete: isActive && !pending(plan, state, course, now) && !(completesTrack && today < earliest), completedAt: completed || null };
    });
    const studyEnd = Math.max(start, ...courses.map(c => c.end));
    const finished = courses.every(c => c.status === 'completed');
    const baselineStudyEnd = earliest - track.ReserveDays;
    const reserveStart = Math.max(studyEnd, baselineStudyEnd) + 1;
    return { ...track, start, end: reserveStart + track.ReserveDays - 1, earliest, studyEnd, waitStart: studyEnd < baselineStudyEnd ? studyEnd + 1 : null, waitEnd: baselineStudyEnd, reserveStart, finished, courses };
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
  const remaining = plan.Courses.filter(c => c.TrackId === course.TrackId && !state.CourseCompleted[c.Id] && !state.DeferredCourses?.[c.Id]);
  if (remaining.length === 1 && localDay(now, plan) < earliestFinish(plan, state, course.TrackId)) throw new Error('Завершение предмета доступно с ' + dayISO(earliestFinish(plan, state, course.TrackId)) + ': соблюдаем минимальный срок и запас.');
  state.ProgressBeforeComplete ||= {};
  state.ProgressBeforeComplete[id] = state.Progress[id] || 0;
  state.CourseCompleted[id] = now.toISOString();
  state.Progress[id] = 100;
  const next = activeCourse(plan, state, course.TrackId);
  if (next && !state.CourseStarted[next.Id]) state.CourseStarted[next.Id] = now.toISOString();
  state.SelectedId = next?.Id || id;
  return next;
}
export function uncompleteCourse(plan, state, id) {
  if (!plan.Courses.some(c => c.Id === id)) throw new Error('Неизвестный модуль.');
  if (!state.CourseCompleted[id]) throw new Error('Этот модуль ещё не отмечен как пройденный.');
  delete state.CourseCompleted[id];
  const progress = Object.hasOwn(state.ProgressBeforeComplete || {}, id) ? state.ProgressBeforeComplete[id] : state.Progress[id] || 0;
  if (progress) state.Progress[id] = progress; else delete state.Progress[id];
  if (state.ProgressBeforeComplete) delete state.ProgressBeforeComplete[id];
  state.SelectedId = id;
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
    let previousStart = oldStart;
    for (const course of trackCourses(plan, state, track.Id)) {
      const begin = state.CoursePlanStart[course.Id] ? Math.floor(Date.parse(state.CoursePlanStart[course.Id]) / DAY) : previousStart;
      if (!state.CourseCompleted[course.Id]) state.CoursePlanStart[course.Id] = dayISO(begin + delta);
      previousStart = begin + courseDays(course, plan);
    }
    state.TrackPlanStart[track.Id] = date;
  }
}
export function reminderOrder(plan, state = {}) {
  const groups = plan.Tracks.map(t => trackCourses(plan, state, t.Id));
  return Array.from({length: Math.max(...groups.map(g => g.length))}, (_, i) => groups.map(g => g[i]).filter(Boolean)).flat();
}
export function reminderTarget(plan, state, now = new Date()) {
  const order = reminderOrder(plan, state);
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
  if (state.SchemaVersion !== 4 || !ids.has(state.SelectedId) || !Number.isInteger(state.ReminderCursor) || state.ReminderCursor < 0 || state.ReminderCursor >= plan.Courses.length) throw new Error('Повреждён файл прогресса. Данные сохранены; проверьте резервную копию.');
  for (const map of ['TrackStarted', 'CourseStarted', 'CourseCompleted', 'Progress']) if (!state[map] || typeof state[map] !== 'object' || Array.isArray(state[map])) throw new Error('Некорректный файл прогресса: ' + map);
  for (const t of plan.Tracks) {
    if (!timestamp(state.TrackStarted[t.Id])) throw new Error('Нет корректной даты начала предмета.');
    const courses = plan.Courses.filter(c => c.TrackId === t.Id);
    for (const c of courses) {
      const done = state.CourseCompleted[c.Id];
      const start = state.CourseStarted[c.Id];
      if (start && !timestamp(start)) throw new Error('Некорректная дата начала курса.');
      if (done && (!timestamp(done) || !start || Date.parse(done) < Date.parse(start))) throw new Error('Некорректная дата завершения модуля.');
    }
    if (courses.every(c => state.CourseCompleted[c.Id]) && Math.max(...courses.map(c => localDay(state.CourseCompleted[c.Id], plan))) < earliestFinish(plan, state, t.Id)) throw new Error('Нарушен минимальный срок предмета.');
  }
  for (const map of ['CourseStarted', 'CourseCompleted']) for (const [id, v] of Object.entries(state[map])) if (!ids.has(id) || !timestamp(v)) throw new Error('Неизвестный модуль или неверная дата.');
  for (const [id, v] of Object.entries(state.Progress)) if (!ids.has(id) || !Number.isInteger(v) || v < 0 || v > 100) throw new Error('Неверный процент прогресса.');
  for (const [id, v] of Object.entries(state.ProgressBeforeComplete || {})) if (!ids.has(id) || !Number.isInteger(v) || v < 0 || v > 100) throw new Error('Неверный сохранённый процент прогресса.');
  if (state.CourseOrder && (typeof state.CourseOrder !== 'object' || Array.isArray(state.CourseOrder))) throw new Error('Некорректный порядок курсов.');
  if (state.PlanningRevision && plan.Tracks.some(t => !Array.isArray(state.CourseOrder?.[t.Id]))) throw new Error('Неполный порядок курсов.');
  for (const [trackId, order] of Object.entries(state.CourseOrder || {})) {
    const expected = plan.Courses.filter(c => c.TrackId === trackId).map(c => c.Id);
    if (!plan.Tracks.some(t => t.Id === trackId) || !Array.isArray(order) || order.length !== expected.length || new Set(order).size !== expected.length || expected.some(id => !order.includes(id))) throw new Error('Некорректный порядок курсов.');
  }
  if (state.PlanningRevision !== undefined && (!Number.isInteger(state.PlanningRevision) || state.PlanningRevision < 0 || state.PlanningRevision > (plan.PlanningRevision || 0))) throw new Error('Неизвестная редакция плана.');
  if (state.CatalogRevision !== undefined && (!Number.isInteger(state.CatalogRevision) || state.CatalogRevision < 0 || state.CatalogRevision > (plan.CatalogRevision || 0))) throw new Error('Неизвестная редакция каталога.');
  if (state.DeferredCourses && (typeof state.DeferredCourses !== 'object' || Array.isArray(state.DeferredCourses))) throw new Error('Некорректный список отложенных курсов.');
  for (const [id, value] of Object.entries(state.DeferredCourses || {})) if (!ids.has(id) || typeof value !== 'boolean') throw new Error('Некорректный отложенный курс.');
  for (const key of ['NextNotificationUtc', 'SnoozeUtc']) if (state[key] && !timestamp(state[key])) throw new Error('Неверная дата напоминания.');
  for (const map of ['TrackPlanStart','CoursePlanStart']) for (const [id, date] of Object.entries(state[map] || {})) {
    if (!(map === 'TrackPlanStart' ? plan.Tracks.some(t => t.Id === id) : ids.has(id)) || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0,10) !== date) throw new Error('Некорректная дата плана.');
  }
  for (const field of Object.keys(importantDateLabels)) {
    if (Object.hasOwn(state, field) && state[field] !== null && !validImportantDate(state[field])) throw new Error('Укажите корректную дату ' + importantDateLabels[field] + '.');
  }
  resolveImportantDates(plan, state);
  if (state.Program && !['technological','general'].includes(state.Program)) throw new Error('Неизвестная программа предпринимательства.');
  return state;
}
