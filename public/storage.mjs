import { createState, applyAction, effectivePlan } from './profile.mjs?v=5';
import { reminderTarget, activate, migrateState, validateState } from './core.mjs?v=5';
let database;
function open() {return database ||= new Promise((resolve,reject)=>{const r=indexedDB.open('coursera-personal-calendar-v3',1);r.onupgradeneeded=()=>r.result.createObjectStore('profiles');r.onsuccess=()=>resolve(r.result);r.onerror=()=>{database=null;reject(new Error('Разреши хранение данных для этого сайта.'));};});}
async function transaction(plan,change=null) {
 const db=await open();
 return new Promise((resolve,reject)=>{
  const tx=db.transaction('profiles','readwrite'),store=tx.objectStore('profiles'),read=store.get('personal');let result;
  read.onsuccess=()=>{
   try {const current=read.result||{state:createState(plan),version:1};const migrated=migrateState(plan,current.state);validateState(plan,current.state);const activated=activate(effectivePlan(plan,current.state),current.state,new Date());if(migrated||activated)current.version++;result=change?change(current):current;if(result)store.put({state:result.state,version:result.version},'personal');}
   catch(error){reject(error);tx.abort();}
  };
  tx.oncomplete=()=>resolve(result);tx.onerror=()=>reject(new Error('Не удалось сохранить изменения.'));tx.onabort=()=>reject(new Error('Изменения не сохранены.'));
 });
}
export const readProfile=plan=>transaction(plan);
export const changeProfile=(plan,input,version)=>transaction(plan,current=>{
 if(version!==current.version)throw new Error('План изменился в другой вкладке. Повтори действие.');
 return {state:applyAction(plan,current.state,input),version:current.version+1};
});
export const claimReminder=plan=>transaction(plan,current=>{
 const state=current.state,now=new Date();
 if(!state.NotificationsEnabled||!state.NextNotificationUtc||Date.parse(state.NextNotificationUtc)>now.getTime()||state.SnoozeUtc&&Date.parse(state.SnoozeUtc)>now.getTime())return null;
 const target=reminderTarget(effectivePlan(plan,state),state,now);
 state.NextNotificationUtc=new Date(now.getTime()+plan.ReminderMinutes*60000).toISOString();state.SnoozeUtc=null;
 if(target)state.ReminderCursor=(target.position+1)%target.count;
 return {state,version:current.version+1,reminder:target?{title:'Время для '+target.course.Title,body:'Продолжи текущий модуль · '+target.course.Hours+' ч по плану',url:target.course.Url}:null};
});
