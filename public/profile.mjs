import { clone, DAY, localDay, dayISO, activate, buildSchedule, completeCourse, uncompleteCourse, initializeCoursePlan, migrateState, reschedule, validateState, trackCourses } from './core.mjs?v=5';

export function createState(plan, now = new Date(), start = dayISO(localDay(now, plan))) {
  const began = new Date(Date.parse(start) - plan.TimeZoneOffsetMinutes * 60000).toISOString();
  const state = { SchemaVersion:3, TrackStarted:Object.fromEntries(plan.Tracks.map(t=>[t.Id,began])), TrackPlanStart:Object.fromEntries(plan.Tracks.map(t=>[t.Id,start])), CoursePlanStart:{}, CourseStarted:{}, CourseCompleted:{}, Progress:{}, ProgressBeforeComplete:{}, SelectedId:plan.Courses[0].Id, ReminderCursor:0, Program:'technological', NotificationsEnabled:false, NextNotificationUtc:null, SnoozeUtc:null, SubscriptionEndDate:plan.SubscriptionEndDate ?? null, ApplicationStartDate:plan.ApplicationStartDate ?? null, ApplicationEndDate:plan.ApplicationEndDate ?? null };
  initializeCoursePlan(plan, state);
  migrateState(plan, state);
  activate(plan, state, now);
  return state;
}
export function effectivePlan(plan, state) {
  const Tracks=state.Program==='general'?plan.Tracks.filter(t=>t.Id!=='entrepreneurship'):plan.Tracks;
  const Courses=Tracks.flatMap(t=>trackCourses(plan,state,t.Id));
  return {...plan,Tracks,Courses};
}
export function snapshot(plan, profile, now = new Date(), pushReady = false) {
  const current = effectivePlan(plan, profile.state);
  return { plan:current, originalTracks:plan.Tracks, state:profile.state, version:profile.version, schedule:buildSchedule(current,profile.state,now), pushReady, notificationError:profile.notificationError || null };
}
export function applyAction(plan, original, input, now = new Date()) {
  const state = clone(original); migrateState(plan,state);
  const current = effectivePlan(plan,state);
  const course = current.Courses.find(c=>c.Id===input.id);
  switch(input.type) {
    case 'select': if(!course)throw new Error('Неизвестный модуль.');state.SelectedId=course.Id;break;
    case 'complete': completeCourse(current,state,input.id,now);break;
    case 'uncomplete': uncompleteCourse(current,state,input.id);break;
    case 'progress':
      if(!course || state.CourseCompleted[input.id] || !Number.isInteger(input.value) || input.value<0 || input.value>100)throw new Error('Укажите процент от 0 до 100 для непройденного модуля.');
      state.Progress[input.id]=input.value;break;
    case 'defer':
      if(!course || course.Availability!=='unconfirmed' || state.CourseCompleted[input.id] || typeof input.value!=='boolean')throw new Error('Этот модуль нельзя отложить.');
      state.DeferredCourses ||= {};
      if(input.value)state.DeferredCourses[input.id]=true;else delete state.DeferredCourses[input.id];
      break;
    case 'settings':
      if(!['technological','general'].includes(input.program))throw new Error('Неизвестная программа.');
      for(const entry of input.dates || [])reschedule(plan,state,entry.value,entry.id);
      for(const field of ['SubscriptionEndDate','ApplicationStartDate','ApplicationEndDate']) if(Object.hasOwn(input,field))state[field]=input[field];
      state.Program=input.program;
      if(!effectivePlan(plan,state).Courses.some(c=>c.Id===state.SelectedId))state.SelectedId=plan.Courses[0].Id;
      break;
    case 'reschedule':reschedule(plan,state,input.date,input.trackId);break;
    case 'program':
      if(!['technological','general'].includes(input.program))throw new Error('Неизвестная программа.');
      state.Program=input.program;
      if(!effectivePlan(plan,state).Courses.some(c=>c.Id===state.SelectedId))state.SelectedId=plan.Courses[0].Id;break;
    case 'pause':state.SnoozeUtc=new Date(now.getTime()+DAY/24).toISOString();state.NextNotificationUtc=state.SnoozeUtc;break;
    case 'resume':state.SnoozeUtc=null;state.NextNotificationUtc=now.toISOString();break;
    case 'notifications':
      state.NotificationsEnabled=!!input.enabled;state.SnoozeUtc=null;state.NextNotificationUtc=input.enabled?new Date(now.getTime()+plan.ReminderMinutes*60000).toISOString():null;break;
    case 'reset':return createState(plan,now);
    default:throw new Error('Неизвестное действие.');
  }
  activate(effectivePlan(plan,state),state,now);
  return validateState(plan,state);
}
