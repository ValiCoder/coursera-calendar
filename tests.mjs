import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildSchedule, completeCourse, reschedule, reminderTarget, validateState, dayISO, earliestFinish, migrateState, importantDates, trackCourses } from './core.mjs';
import { createState, effectivePlan, applyAction } from './profile.mjs';
const plan = JSON.parse(fs.readFileSync(new URL('./data/plan.json',import.meta.url),'utf8').replace(/^\uFEFF/,''));
function fresh(){return createState(plan,new Date('2026-10-08T14:00Z'),'2026-10-07');}
test('baseline matches all 32 modules and the saved 7 Oct–2 Nov schedule',()=>{
  const s=buildSchedule(plan,fresh(),new Date('2026-10-08T14:00Z'));
  assert.equal(s.tracks.flatMap(t=>t.courses).length,32);
  assert.equal(dayISO(s.start),'2026-10-07');assert.equal(dayISO(s.end),'2026-11-02');
  assert.equal(dayISO(s.tracks[0].courses[1].start),'2026-10-09');
  assert.equal(dayISO(s.tracks[2].courses[1].start),'2026-10-09');
});
test('completion activates the next module without changing its planned dates',()=>{
  const state=fresh();completeCourse(plan,state,'qa-quality-testing',new Date('2026-10-08T14:00Z'));
  assert.equal(state.CourseStarted['qa-practical-testing'],'2026-10-08T14:00:00.000Z');
  assert.equal(Object.keys(state.CourseCompleted).length,1);
  assert.equal(state.CoursePlanStart['qa-practical-testing'],'2026-10-09');
  assert.throws(()=>completeCourse(plan,state,'qa-modern-testing-tools',new Date('2026-10-08T15:00Z')),/предыдущий/);
  validateState(plan,state);
});
test('shifting start moves future modules but preserves actual completion history',()=>{
  const state=fresh();completeCourse(plan,state,'qa-quality-testing',new Date('2026-10-08T14:00Z'));
  const actual=state.CourseCompleted['qa-quality-testing'];reschedule(plan,state,'2026-10-10');
  const s=buildSchedule(plan,state,new Date('2026-10-08T16:00Z'));
  assert.equal(state.CourseCompleted['qa-quality-testing'],actual);
  assert.equal(dayISO(s.tracks[0].courses[0].end),'2026-10-08');
  assert.equal(dayISO(s.tracks[2].courses[0].start),'2026-10-10');
  assert.equal(dayISO(s.tracks[0].courses[1].start),'2026-10-12');
  assert.equal(dayISO(earliestFinish(plan,state,'architecture')),'2026-11-05');
  assert.throws(()=>completeCourse(plan,state,'architecture-design',new Date('2026-10-08T16:00Z')),/ещё/);
});
test('individual track shift and malformed dates',()=>{
  const state=fresh();reschedule(plan,state,'2026-10-12','security');
  assert.equal(state.TrackPlanStart.qa,'2026-10-07');assert.equal(state.TrackPlanStart.security,'2026-10-12');
  assert.throws(()=>reschedule(plan,state,'2026-02-31'),/корректную/);
});
test('reminders target active courses and skip completed/future rows',()=>{
  const state=fresh();completeCourse(plan,state,'qa-quality-testing',new Date('2026-10-08T14:00Z'));
  assert.equal(reminderTarget(plan,state,new Date('2026-10-08T15:00Z')).course.Id,'security-analyst');
  reschedule(plan,state,'2026-12-01');assert.equal(reminderTarget(plan,state,new Date('2026-10-08T15:00Z')),null);
});
test('last module cannot close a track before its minimum and reserve',()=>{
  const state=fresh(), courses=trackCourses(plan,state,'architecture');
  for(const course of courses.slice(0,-1))completeCourse(plan,state,course.Id,new Date('2026-10-08T14:00Z'));
  assert.throws(()=>completeCourse(plan,state,courses.at(-1).Id,new Date('2026-10-08T15:00Z')),/минимальный/);
});
test('new visitors have separate empty progress, settings and consent',()=>{
 const a=fresh(),b=fresh();assert.deepEqual(a.CourseCompleted,{});assert.deepEqual(a.Progress,{});assert.equal(a.NotificationsEnabled,false);
 const changed=applyAction(plan,a,{type:'progress',id:'architecture-design',value:45});
 assert.equal(changed.Progress['architecture-design'],45);assert.deepEqual(b.Progress,{});assert.deepEqual(a.Progress,{});
 const shifted=applyAction(plan,changed,{type:'reschedule',date:'2026-10-20',trackId:'architecture'});
 assert.equal(b.TrackPlanStart.architecture,'2026-10-07');assert.equal(shifted.TrackPlanStart.architecture,'2026-10-20');
});
test('an untouched future course can start earlier or later',()=>{
 const now=new Date('2026-10-02T12:00Z'),state=createState(plan,now,'2026-10-07');
 reschedule(plan,state,'2026-10-01','architecture');completeCourse(plan,state,'architecture-design',now);validateState(plan,state);
 const later=createState(plan,now,'2026-10-07');reschedule(plan,later,'2026-10-20','architecture');
 assert.throws(()=>completeCourse(plan,later,'architecture-design',now),/ещё/);
 completeCourse(plan,later,'architecture-design',new Date('2026-10-20T12:00Z'));
 assert.equal(later.CourseStarted['architecture-design'],'2026-10-19T19:00:00.000Z');
});
test('finished tracks retain their valid history when other dates change',()=>{
 const state=fresh();for(const c of trackCourses(plan,state,'architecture'))completeCourse(plan,state,c.Id,new Date('2026-11-02T12:00Z'));
 reschedule(plan,state,'2026-11-20');validateState(plan,state);assert.equal(state.TrackPlanStart.architecture,'2026-10-07');
});
test('overdue work never moves planned dates or adds reserve days',()=>{
 const state=fresh();for(const c of trackCourses(plan,state,'architecture').slice(0,-1))completeCourse(plan,state,c.Id,new Date('2026-10-08T14:00Z'));
 for(const d of ['2026-11-01','2026-11-02'])assert.equal(dayISO(buildSchedule(plan,state,new Date(d+'T12:00Z')).tracks.find(t=>t.Id==='architecture').end),'2026-11-02');
 assert.equal(dayISO(buildSchedule(plan,state,new Date('2026-11-03T12:00Z')).tracks.find(t=>t.Id==='architecture').end),'2026-11-02');
});
test('general entrepreneurship hides its pending courses from actions and reminders',()=>{
 let state=applyAction(plan,fresh(),{type:'program',program:'general'}),current=effectivePlan(plan,state);
 assert.equal(current.Courses.length,26);assert.equal(current.Tracks.length,3);
 assert.throws(()=>applyAction(plan,state,{type:'complete',id:'entrepreneurship-scaleup'}),/Неизвестный/);
 for(let i=0;i<32;i++){state.ReminderCursor=i;assert.notEqual(reminderTarget(current,state,new Date('2026-10-08T14:00Z')).course.TrackId,'entrepreneurship');}
 state=applyAction(plan,state,{type:'program',program:'technological'});assert.equal(effectivePlan(plan,state).Courses.length,32);
});
const ranges = schedule => schedule.tracks.map(t=>({id:t.Id,start:t.start,end:t.end,courses:t.courses.map(c=>({id:c.Id,start:c.start,end:c.end,days:c.days}))}));
test('early and late completion preserve every bar length and every planned date',()=>{
 const now=new Date('2026-10-08T14:00Z');
 for(const completedAt of [now,new Date('2026-10-22T14:00Z')]) {
  const state=createState(plan,now,'2026-10-08'),before=ranges(buildSchedule(plan,state,now));
  completeCourse(plan,state,'qa-quality-testing',completedAt);
  completeCourse(plan,state,'qa-practical-testing',completedAt);
  const after=buildSchedule(plan,state,completedAt);
  assert.deepEqual(ranges(after),before);
  assert.equal(after.tracks[0].courses[0].end-after.tracks[0].courses[0].start+1,2);
  assert.equal(dayISO(after.tracks[0].courses[2].start),'2026-10-12');
 }
});
test('undoing an earlier module keeps later completion and can be completed again',()=>{
 const now=new Date('2026-10-08T14:00Z');let state=createState(plan,now,'2026-10-08');
 state=applyAction(plan,state,{type:'complete',id:'qa-quality-testing'},now);
 state=applyAction(plan,state,{type:'complete',id:'qa-practical-testing'},now);
 const secondDone=state.CourseCompleted['qa-practical-testing'],before=ranges(buildSchedule(plan,state,now));
 state=applyAction(plan,state,{type:'uncomplete',id:'qa-quality-testing'},new Date('2026-10-09T14:00Z'));
 assert.equal(state.CourseCompleted['qa-quality-testing'],undefined);
 assert.equal(state.CourseCompleted['qa-practical-testing'],secondDone);
 assert.equal(state.SelectedId,'qa-quality-testing');
 assert.deepEqual(ranges(buildSchedule(plan,state,new Date('2026-10-09T14:00Z'))),before);
 state=applyAction(plan,state,{type:'complete',id:'qa-quality-testing'},new Date('2026-10-10T14:00Z'));
 assert.equal(state.CourseCompleted['qa-practical-testing'],secondDone);
 assert.equal(state.SelectedId,'qa-modern-testing-tools');validateState(plan,state);
});
test('undo restores the previous manual percentage and rejects unmarked modules',()=>{
 const now=new Date('2026-10-08T14:00Z');let state=createState(plan,now);
 state=applyAction(plan,state,{type:'progress',id:'qa-quality-testing',value:45},now);
 state=applyAction(plan,state,{type:'complete',id:'qa-quality-testing'},now);
 state=applyAction(plan,state,{type:'uncomplete',id:'qa-quality-testing'},now);
 assert.equal(state.Progress['qa-quality-testing'],45);
 assert.throws(()=>applyAction(plan,state,{type:'uncomplete',id:'qa-practical-testing'},now),/ещё не/);
 assert.throws(()=>applyAction(plan,state,{type:'uncomplete',id:'unknown'},now),/Неизвестный/);
});
test('legacy profiles recover shifted and compressed bars without losing progress',()=>{
 const now=new Date('2026-10-08T14:00Z');let state=createState(plan,now,'2026-10-08');
 state=applyAction(plan,state,{type:'complete',id:'qa-quality-testing'},now);
 state=applyAction(plan,state,{type:'complete',id:'qa-practical-testing'},now);
 state=applyAction(plan,state,{type:'reschedule',date:'2026-10-20',trackId:'security'},now);
 state.Program='general';state.Progress['qa-modern-testing-tools']=55;state.SchemaVersion=1;
 state.CoursePlanStart={'qa-modern-testing-tools':'2026-10-08'};delete state.ProgressBeforeComplete;
 const completed=structuredClone(state.CourseCompleted),started=structuredClone(state.CourseStarted),progress=structuredClone(state.Progress);
 assert.equal(migrateState(plan,state),true);
 assert.equal(state.SchemaVersion,3);assert.equal(Object.keys(state.CoursePlanStart).length,32);
 assert.equal(state.CoursePlanStart['qa-practical-testing'],'2026-10-10');
 assert.equal(state.CoursePlanStart['qa-modern-testing-tools'],'2026-10-12');
 assert.equal(state.CoursePlanStart['security-analyst'],'2026-10-20');
 assert.equal(state.CoursePlanStart['entrepreneurship-scaleup'],'2026-10-08');
 assert.deepEqual(state.CourseCompleted,completed);assert.deepEqual(state.CourseStarted,started);assert.deepEqual(state.Progress,progress);
 validateState(plan,state);
 reschedule(plan,state,'2026-10-09','qa');const dates=structuredClone(state.CoursePlanStart);
 assert.equal(migrateState(plan,state),false);assert.deepEqual(state.CoursePlanStart,dates);
 const undone=applyAction(plan,state,{type:'uncomplete',id:'qa-quality-testing'},now);
 assert.equal(undone.Progress['qa-quality-testing'],100);
 assert.equal(undone.CourseCompleted['qa-practical-testing'],completed['qa-practical-testing']);
});
test('finishing an entire track preserves its original calendar span',()=>{
 const state=fresh(),now=new Date('2026-11-02T12:00Z'),before=ranges(buildSchedule(plan,state,now));
 for(const c of trackCourses(plan,state,'architecture'))completeCourse(plan,state,c.Id,now);
 assert.deepEqual(ranges(buildSchedule(plan,state,now)),before);validateState(plan,state);
});
test('completion across UTC+5 midnight records the fact separately from the plan',()=>{
 const now=new Date('2026-10-07T20:00Z'),state=createState(plan,now,'2026-10-08');
 completeCourse(plan,state,'qa-quality-testing',now);
 const course=buildSchedule(plan,state,now).tracks[0].courses[0];
 assert.equal(dayISO(course.start),'2026-10-08');assert.equal(dayISO(course.end),'2026-10-09');
  assert.equal(course.completedAt,'2026-10-07T20:00:00.000Z');
});

test('new profiles seed personal subscription and application dates from the plan',()=>{
 const now=new Date('2026-10-09T12:00Z'),state=createState(plan,now);
 assert.equal(state.SchemaVersion,3);
 assert.equal(state.SubscriptionEndDate,'2026-11-05');
 assert.equal(state.ApplicationStartDate,'2026-11-01');
 assert.equal(state.ApplicationEndDate,'2026-11-09');
 const dates=importantDates(plan,state,now);
 assert.equal(dayISO(dates.subscriptionEndDay),'2026-11-05');
 assert.equal(dayISO(dates.applicationStartDay),'2026-11-01');
 assert.equal(dayISO(dates.applicationEndDay),'2026-11-09');
 assert.equal(dates.subscriptionRemainingDays,27);
 assert.equal(dates.applicationStatus,'upcoming');
 assert.equal(dates.applicationRemainingDays,23);
 validateState(plan,state);
});

test('legacy schema 2 profiles use deadline defaults without rewriting their data',()=>{
 const now=new Date('2026-10-09T12:00Z'),state=fresh();
 delete state.SubscriptionEndDate;delete state.ApplicationStartDate;delete state.ApplicationEndDate;
 const before=structuredClone(state);
 const dates=importantDates(plan,state,now);
 assert.equal(dates.subscriptionRemainingDays,27);
 assert.equal(dates.applicationStatus,'upcoming');
 assert.equal(dates.applicationRemainingDays,23);
 validateState(plan,state);assert.deepEqual(state,before);
 const withoutDefaults={...plan};delete withoutDefaults.SubscriptionEndDate;delete withoutDefaults.ApplicationStartDate;delete withoutDefaults.ApplicationEndDate;
 assert.deepEqual(importantDates(withoutDefaults,state,now),{
  subscriptionEndDay:null,applicationStartDay:null,applicationEndDay:null,subscriptionRemainingDays:null,applicationStatus:null,applicationRemainingDays:null
 });
});

test('editing and clearing personal deadlines preserves course dates, facts and progress',()=>{
 const now=new Date('2026-10-09T12:00Z');let state=fresh();
 state=applyAction(plan,state,{type:'progress',id:'qa-quality-testing',value:45},now);
 state=applyAction(plan,state,{type:'complete',id:'qa-quality-testing'},now);
 state=applyAction(plan,state,{type:'progress',id:'architecture-design',value:70},now);
 const before=structuredClone(state),beforePlan=structuredClone(plan),beforeRanges=ranges(buildSchedule(plan,state,now));
 const edited=applyAction(plan,state,{type:'settings',program:state.Program,dates:[],SubscriptionEndDate:'2026-11-20',ApplicationStartDate:'2026-11-03',ApplicationEndDate:'2026-11-10'},now);
 assert.equal(edited.SubscriptionEndDate,'2026-11-20');
 assert.equal(edited.ApplicationStartDate,'2026-11-03');assert.equal(edited.ApplicationEndDate,'2026-11-10');
 for(const field of ['TrackStarted','TrackPlanStart','CoursePlanStart','CourseStarted','CourseCompleted','Progress','ProgressBeforeComplete'])assert.deepEqual(edited[field],before[field]);
 assert.deepEqual(ranges(buildSchedule(plan,edited,now)),beforeRanges);
 const cleared=applyAction(plan,edited,{type:'settings',program:edited.Program,dates:[],SubscriptionEndDate:null,ApplicationStartDate:null,ApplicationEndDate:null},now);
 assert.deepEqual(importantDates(plan,cleared,now),{
  subscriptionEndDay:null,applicationStartDay:null,applicationEndDay:null,subscriptionRemainingDays:null,applicationStatus:null,applicationRemainingDays:null
 });
 for(const field of ['TrackStarted','TrackPlanStart','CoursePlanStart','CourseStarted','CourseCompleted','Progress','ProgressBeforeComplete'])assert.deepEqual(cleared[field],before[field]);
 assert.deepEqual(ranges(buildSchedule(plan,cleared,now)),beforeRanges);
 assert.deepEqual(state,before);assert.deepEqual(plan,beforePlan);
 assert.equal(createState(plan,now).SubscriptionEndDate,'2026-11-05');
});

test('old settings and inherited input fields do not replace personal deadlines',()=>{
 const now=new Date('2026-10-09T12:00Z');
 const state=applyAction(plan,fresh(),{type:'settings',program:'technological',SubscriptionEndDate:'2026-12-05',ApplicationStartDate:'2026-12-01',ApplicationEndDate:'2026-12-09'},now);
 for(const input of [
  {type:'settings',program:'general',dates:[]},
  Object.assign(Object.create({SubscriptionEndDate:'2020-01-01',ApplicationStartDate:null,ApplicationEndDate:null}),{type:'settings',program:'technological',dates:[]})
 ]) {
  const changed=applyAction(plan,state,input,now);
  for(const field of ['SubscriptionEndDate','ApplicationStartDate','ApplicationEndDate'])assert.equal(changed[field],state[field]);
 }
 const cleared=applyAction(plan,state,{type:'settings',program:'technological',SubscriptionEndDate:null,ApplicationStartDate:null,ApplicationEndDate:null},now);
 const unchanged=applyAction(plan,cleared,{type:'settings',program:'technological',dates:[]},now);
 assert.equal(importantDates(plan,unchanged,now).subscriptionEndDay,null);
 assert.equal(importantDates(plan,unchanged,now).applicationStatus,null);
});

test('deadline edits reject malformed dates and inconsistent application windows atomically',()=>{
 const now=new Date('2026-10-09T12:00Z'),state=fresh(),before=structuredClone(state);
 for(const field of ['SubscriptionEndDate','ApplicationStartDate','ApplicationEndDate']) {
  for(const value of ['2026-02-31','2026-11-5','2019-12-31','2101-01-01','2026-11-05T00:00:00Z','',undefined,42,false,{}]) {
   assert.throws(()=>applyAction(plan,state,{type:'settings',program:'technological',dates:[{id:'qa',value:'2026-10-20'}],[field]:value},now),/корректную дату/);
   assert.deepEqual(state,before);
   assert.throws(()=>validateState(plan,{...state,[field]:value}),/корректную дату/);
  }
 }
 for(const input of [
  {ApplicationStartDate:null},
  {ApplicationEndDate:null},
  {ApplicationStartDate:'2026-11-10',ApplicationEndDate:'2026-11-09'}
 ]) {
  assert.throws(()=>applyAction(plan,state,{type:'settings',program:'technological',...input},now),/обе даты|позже окончания/);
  assert.throws(()=>validateState(plan,{...state,...input}),/обе даты|позже окончания/);
  assert.deepEqual(state,before);
 }
 assert.equal(applyAction(plan,state,{type:'settings',program:'technological',SubscriptionEndDate:'2020-02-29',ApplicationStartDate:'2100-12-31',ApplicationEndDate:'2100-12-31'},now).SubscriptionEndDate,'2020-02-29');
});

test('important dates follow inclusive application days and subscription expiry in UTC+5',()=>{
 const state=fresh();
 const cases=[
  ['2026-10-31T18:59:59.999Z','upcoming',1,5],
  ['2026-10-31T19:00:00.000Z','open',9,4],
  ['2026-11-04T19:00:00.000Z','open',5,0],
  ['2026-11-05T18:59:59.999Z','open',5,0],
  ['2026-11-05T19:00:00.000Z','open',4,-1],
  ['2026-11-09T18:59:59.999Z','open',1,-4],
  ['2026-11-09T19:00:00.000Z','closed',0,-5]
 ];
 for(const [time,status,remaining,subscription] of cases) {
  const dates=importantDates(plan,state,new Date(time));
  assert.equal(dates.applicationStatus,status,time);
  assert.equal(dates.applicationRemainingDays,remaining,time);
  assert.equal(dates.subscriptionRemainingDays,subscription,time);
 }
 const oneDay={...state,ApplicationStartDate:'2026-11-01',ApplicationEndDate:'2026-11-01'};
 assert.equal(importantDates(plan,oneDay,new Date('2026-10-31T19:00Z')).applicationRemainingDays,1);
 assert.equal(importantDates(plan,oneDay,new Date('2026-11-01T19:00Z')).applicationStatus,'closed');
});
