import { snapshot } from './profile.mjs?v=6';
import { reminderTarget, importantDates } from './core.mjs?v=6';
import { readProfile, changeProfile, claimReminder } from './storage.mjs?v=6';
const $ = id => document.getElementById(id);
let data, plan, selected, view = 'calendar', weekStart = null, completeId, completeMode = 'complete', dirtySettings = false, swRegistration, calendarStart, calendarEnd;
const colors = {qa:['#2463df','#e3edff','Тестирование'], security:['#24a38b','#e3f3ef','Безопасность'], architecture:['#7e62d7','#eee9fb','Архитектура'], entrepreneurship:['#d29436','#fcf2df','Технологическое предпринимательство']};
const subcourseNames = {'entrepreneurship-scaleup':['Why Scale a Startup?','Scaling Product and Processes','Building Culture in a Scale Up','Scale Up Specialization Capstone'], 'security-analyst':['Penetration Testing, Threat Hunting, and Cryptography','Incident Response and Digital Forensics','Cybersecurity Case Studies and Capstone Project']};
const escape = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c]));
const date = day => new Date(day * 86400000);
const fmt = (day, opts={day:'numeric',month:'short'}) => date(day).toLocaleDateString('ru-RU',{timeZone:'UTC',...opts}).replace(' г.','');
const localTime = iso => new Date(iso).toLocaleTimeString('ru-RU',{timeZone:'Asia/Qyzylorda',hour:'2-digit',minute:'2-digit'});
const dateISO = day => date(day).toISOString().slice(0,10);
const getCourse = id => data.schedule.tracks.flatMap(t => t.courses).find(c => c.Id === id);
const statusName = c => c.status === 'completed' ? 'Пройден' : c.status === 'deferred' ? 'Отложен' : c.status === 'overdue' ? 'Продолжить' : c.status === 'active' ? 'В работе' : 'В плане';
const colorStyle = trackId => `--track-color:${colors[trackId][0]};--track-pale:${colors[trackId][1]}`;
const formatHours = value => value.toLocaleString('ru-RU',{maximumFractionDigits:1});
function showToast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(showToast.timer); showToast.timer = setTimeout(() => $('toast').hidden = true,4500); }
async function action(value) {
  if(value.type==='test'){
    const target=reminderTarget(data.plan,data.state);if(!target)throw new Error('Нет активных модулей: проверь дату начала.');
    await displayNotification({title:'Проверка напоминаний',body:target.course.Title,url:target.course.Url});return {sent:true};
  }
  try {const profile=await changeProfile(plan,value,data.version);data=snapshot(plan,profile);selected=data.state.SelectedId;if(value.type==='select')renderSelection();else render();return data;}
  catch(error){await load();throw error;}
}
async function load() {
  try {
    const profile=await readProfile(plan);data=snapshot(plan,profile);selected=data.state.SelectedId;
    $('connection-error').hidden = true;
    render();
    return true;
  } catch(error) {$('connection-error').textContent = error.message+' Нажми «Повторить» после изменения настройки.'; $('connection-error').hidden = false; $('retry-load').hidden=false; return false;}
}
function render() {
  const schedule = data.schedule;
  const today = schedule.today;
  $('today-label').textContent = fmt(today,{day:'numeric',month:'long',year:'numeric'});
  $('header-description').textContent = data.state.Program === 'general' ? 'Обычное предпринимательство: ожидаем отдельный список. Три других предмета доступны.' : 'Четыре предмета · Technological Entrepreneurship · расширенный план';
  $('plan-update-note').textContent = 'Все курсы из расчёта сохранены вместе с дополнительными. Расписание по 10 октября включительно сохранено; дальнейший порядок уточнён. Часы обозначают объём программ, а не личную дневную нагрузку.';
  const completed = data.plan.Courses.filter(c => data.state.CourseCompleted[c.Id]).length;
  $('stat-completed').innerHTML = `${completed} <span>/ ${data.plan.Courses.length}</span>`;
  $('total-progress').style.width = completed / data.plan.Courses.length * 100 + '%';
  $('stat-hours').innerHTML = `${data.plan.Courses.reduce((a,c)=>a+c.Hours,0)} <span>часов</span>`;
  $('stat-finish').textContent = fmt(schedule.end,{day:'numeric',month:'long'});
  renderImportantDates();
  const paused = data.state.SnoozeUtc && new Date(data.state.SnoozeUtc) > new Date();
  const enabled = data.state.NotificationsEnabled;
  $('stat-reminder').textContent = !enabled ? 'Выключено' : paused ? 'На паузе' : data.state.NextNotificationUtc ? localTime(data.state.NextNotificationUtc) : 'Скоро';
  $('reminder-note').textContent = paused ? 'До '+ localTime(data.state.SnoozeUtc) : 'Каждые ' + data.plan.ReminderMinutes + ' минут';
  $('notifications-enable').textContent = enabled ? 'Настройки уведомлений' : 'Включить уведомления';
  $('notification-test').disabled = !enabled;
  $('pause-button').disabled = !enabled;
  $('pause-button').textContent = paused ? 'Возобновить' : 'Пауза на час';
  $('notification-status').textContent = data.notificationError ? 'Не удалось отправить: '+data.notificationError : !enabled ? 'Включи уведомления, чтобы не пропускать занятия.' : paused ? 'Напоминания приостановлены до '+localTime(data.state.SnoozeUtc)+'.' : 'Напоминания включены — текущие модули чередуются.';
  $('helper-status').textContent = 'Напоминания работают, пока календарь открыт. После закрытия вкладки они прекращаются.';
  if (enabled) $('notification-invite').hidden = true;
  const filter = $('track-filter').value || 'all';
  $('track-navigation').innerHTML = data.schedule.tracks.map(t=>`<button class="track-nav ${filter===t.Id?'selected':''}" data-filter="${t.Id}" style="${colorStyle(t.Id)}"><span class="track-dot"></span>${colors[t.Id][2]}<span class="track-nav-count">${t.courses.filter(c=>c.status==='completed').length}/${t.courses.length}</span></button>`).join('') + (data.state.Program==='general'?'<button class="track-nav" id="pending-program-settings"><span class="track-dot" style="--track-color:#d29436"></span>Предпринимательство<span class="track-nav-count">ждём</span></button>':'');
  $('track-filter').innerHTML = '<option value="all">Все предметы</option>'+schedule.tracks.map(t=>`<option value="${t.Id}">${colors[t.Id][2]}</option>`).join('');
  $('track-filter').value = [...$('track-filter').options].some(o=>o.value===filter) ? filter : 'all';
  $('current-courses').innerHTML = schedule.tracks.map(t=>{
    const totalHours=t.courses.reduce((sum,course)=>sum+course.Hours,0);
    const completedHours=t.courses.reduce((sum,course)=>sum+course.Hours*course.progress/100,0);
    const unavailableHours=t.courses.filter(course=>course.Availability==='unconfirmed').reduce((sum,course)=>sum+course.Hours,0);
    const availableNote=unavailableHours?'<br>Без недоступного блока: '+formatHours(totalHours-unavailableHours)+' ч':'';
    const subjectHours=`<div class="course-card-hours">Предмет: ${formatHours(totalHours)} ч · Пройдено: ${formatHours(completedHours)} ч${availableNote}</div>`;
    const c = t.courses.find(c=>c.active);
    if (!c) {
      const deferred=t.courses.filter(x=>x.status==='deferred');
      return `<article class="course-card" style="${colorStyle(t.Id)}"><div class="course-card-head">${colors[t.Id][2]}</div><h2>${deferred.length?'Доступные модули завершены':'Предмет завершён'}</h2><p class="course-card-meta">${deferred.length?'Отложено модулей: '+deferred.length+'. Их можно вернуть в плане.':'Все модули пройдены'}</p>${subjectHours}</article>`;
    }
    const sub = data.state.SubcourseProgress?.[c.Id];
    const subIndex = sub?.findIndex(v=>v<100);
    const subName = sub && subIndex >= 0 ? subcourseNames[c.Id]?.[subIndex] || '' : '';
    const value = sub ? sub[subIndex] || 0 : c.progress;
    const progressText = sub ? `${sub.filter(v=>v===100).length}/${sub.length} курсов · текущий: ${value}%` : `${c.progress}% пройдено`;
    return `<article class="course-card ${selected===c.Id?'selected':''}" data-course="${c.Id}" style="${colorStyle(t.Id)}"><div class="course-card-head"><span>${colors[t.Id][2]}</span><span class="tag ${c.status}">${statusName(c)}</span></div><button class="course-card-title" data-select="${c.Id}">${escape(subName || c.Title)}</button><div class="course-card-meta">${subName?escape(c.Title):fmt(c.start)+' — '+fmt(c.end)+' · '+c.Hours+' ч'}</div>${subjectHours}<div class="card-progress"><span style="width:${value}%"></span></div><div class="card-bottom"><span>${progressText}</span><button data-select="${c.Id}">Продолжить</button></div></article>`;
  }).join('') + (data.state.Program==='general'?'<article class="course-card" style="--track-color:#d29436"><div class="course-card-head">Предпринимательство</div><h2 class="course-card-title">Ожидаем список курсов</h2><div class="course-card-meta">Добавим курсы и рассчитаем даты, когда пришлёшь список.</div><div class="card-bottom"><span>Программа выбрана</span><button id="pending-card-settings">Настроить</button></div></article>':'');
  renderCalendar(); renderModules(); renderSelected(); renderView();
}
function renderImportantDates() {
  const deadlines=importantDates(data.plan,data.state);
  const fullDate=day=>fmt(day,{day:'numeric',month:'long',year:'numeric'});
  const remaining=deadlines.subscriptionRemainingDays;
  $('subscription-date').textContent=deadlines.subscriptionEndDay===null?'Дата не задана':fullDate(deadlines.subscriptionEndDay);
  $('subscription-note').textContent=remaining===null?'Можно указать в настройках.':remaining<0?'Срок подписки прошёл.':remaining===0?'Последний день подписки.':'До окончания: '+remaining+' дн.';
  const conflict=deadlines.subscriptionEndDay!==null&&data.schedule.end>deadlines.subscriptionEndDay;
  $('subscription-conflict').hidden=!conflict;
  $('subscription-conflict').textContent=conflict?'План с запасом заканчивается '+fullDate(data.schedule.end)+' — после срока подписки.':'';
  $('application-dates').textContent=deadlines.applicationStartDay===null?'Даты не заданы':fmt(deadlines.applicationStartDay)+' — '+fullDate(deadlines.applicationEndDay);
  $('application-note').textContent=deadlines.applicationStatus==='upcoming'?'До начала сдачи заявлений: '+deadlines.applicationRemainingDays+' дн.':deadlines.applicationStatus==='open'?'Сдача заявлений открыта · осталось '+deadlines.applicationRemainingDays+' дн., включая сегодня.':deadlines.applicationStatus==='closed'?'Период сдачи заявлений завершён.':'Можно указать в настройках.';
}
function visibleTracks() {return data.schedule.tracks.filter(t=>$('track-filter').value==='all'||t.Id===$('track-filter').value);}
function renderSelection() {
  document.querySelectorAll('[data-course]').forEach(row=>row.classList.toggle('selected',row.dataset.course===selected));
  renderSelected();
}
const courseRow = target => target.closest('.gantt-row[data-course], .module-table tr[data-course]');
const isCourseEditor = target => !!target.closest('input, textarea, select, a, [contenteditable]:not([contenteditable="false"])');
function renderCalendar() {
  const all = $('all-plan').checked;
  const shown=visibleTracks();
  const rangeStart = all ? Math.min(...shown.flatMap(t=>[t.start,...t.courses.map(c=>c.start)])) : weekStart ?? data.schedule.today;
  const deadlines=importantDates(data.plan,data.state);
  const fullRangeEnd=Math.max(...shown.map(t=>t.end),...[deadlines.subscriptionEndDay,deadlines.applicationEndDay].filter(day=>day!==null));
  const rangeEnd = all ? Math.min(fullRangeEnd,rangeStart+119) : rangeStart+6;
  calendarStart=rangeStart;calendarEnd=rangeEnd;
  $('calendar-caption').textContent=all&&fullRangeEnd>rangeEnd?'Первые 120 дней. Перейди «К модулю»; двойной клик по строке откроет курс.':'Один клик — детали, двойной клик по строке — открыть курс';
  const days = rangeEnd-rangeStart+1;
  $('calendar-range').textContent = fmt(rangeStart,{day:'numeric',month:'long'})+' — '+fmt(rangeEnd,{day:'numeric',month:'long',year:'numeric'});
  $('gantt').style.setProperty('--days',days);
  const dayBackgrounds = Array.from({length:days},(_,i)=>{
    const d=rangeStart+i, weekend=[0,6].includes(date(d).getUTCDay());
    return weekend||d===data.schedule.today?`<span class="day-background ${weekend?'weekend':''} ${d===data.schedule.today?'today':''}" style="left:calc(var(--day-width) * ${i})"></span>`:'';
  }).join('');
  const bar=(start,end,classes,text,id=null,title='')=>{
    if(end<rangeStart||start>rangeEnd)return '';
    const begin=Math.max(start,rangeStart), finish=Math.min(end,rangeEnd), duration=finish-begin+1;
    return `<${id?'button':'div'} class="gantt-bar ${classes}" ${id?`data-select="${id}"`:''} style="left:calc(var(--day-width) * ${begin-rangeStart} + 3px);width:calc(var(--day-width) * ${duration} - 6px)" title="${escape(title||text)}">${escape(text)}</${id?'button':'div'}>`;
  };
  const head=`<div class="gantt-row gantt-header"><div class="gantt-label"><div class="label-text"><strong>Предмет / модуль</strong><small>Часы · даты плана</small></div></div><div class="gantt-dates">${Array.from({length:days},(_,i)=>{
    const d=rangeStart+i, dt=date(d), weekend=[0,6].includes(dt.getUTCDay());
    return `<div class="date-cell ${weekend?'weekend':''} ${d===data.schedule.today?'today':''}"><span class="month">${dt.toLocaleDateString('ru-RU',{month:'short',timeZone:'UTC'}).replace('.','')}</span><span class="date-number">${dt.getUTCDate()}</span><span class="weekday">${dt.toLocaleDateString('ru-RU',{weekday:'short',timeZone:'UTC'})}</span></div>`;
  }).join('')}</div></div>`;
  const deadlineRow=(label,detail,start,end,classes,text)=>'<div class="gantt-row deadline-row"><div class="gantt-label"><div class="label-text"><strong>'+label+'</strong><small>'+detail+'</small></div></div><div class="gantt-timeline">'+dayBackgrounds+bar(start,end,classes,text,null,label+' · '+detail)+'</div></div>';
  let deadlineRows='';
  if(deadlines.subscriptionEndDay!==null)deadlineRows+=deadlineRow('Подписка Coursera','Последний день · '+fmt(deadlines.subscriptionEndDay),deadlines.subscriptionEndDay,deadlines.subscriptionEndDay,'subscription-deadline',String(date(deadlines.subscriptionEndDay).getUTCDate()));
  if(deadlines.applicationStartDay!==null)deadlineRows+=deadlineRow('Сдача заявлений',fmt(deadlines.applicationStartDay)+' — '+fmt(deadlines.applicationEndDay)+' включительно',deadlines.applicationStartDay,deadlines.applicationEndDay,'application-window','Сдача заявлений');
  const tracks = visibleTracks().map(t=>{
    const trackStart=Math.max(t.start,rangeStart),trackEnd=Math.min(t.end,rangeEnd);
    let html=`<div class="gantt-row track-row" style="${colorStyle(t.Id)}"><div class="gantt-label"><span class="track-dot"></span>${colors[t.Id][2]}</div><div class="gantt-timeline">${dayBackgrounds}${trackEnd>=trackStart?`<div class="track-band" style="left:calc(var(--day-width) * ${trackStart-rangeStart} + 3px);width:calc(var(--day-width) * ${trackEnd-trackStart+1} - 6px)">${t.MinimumDays} дней минимум + ${t.ReserveDays} дня запаса</div>`:''}</div></div>`;
    html+=t.courses.map((c,i)=>`<div class="gantt-row ${selected===c.Id?'selected':''}" data-course="${c.Id}" style="${colorStyle(t.Id)}"><button class="gantt-label course-label" data-select="${c.Id}"><span class="number-chip">${c.status==='completed'?'✓':i+1}</span><span class="label-text"><strong>${escape(c.Title)}</strong><small>${c.Hours} ч · ${fmt(c.start)}–${fmt(c.end)} · ${c.days} дн.</small></span></button><div class="gantt-timeline">${dayBackgrounds}${bar(c.start,c.end,c.status,c.status==='completed'?'✓':c.days<=2?c.days+' дн.':fmt(c.start)+'–'+fmt(c.end),c.Id,c.Title+' · '+statusName(c)+' · '+fmt(c.start)+'–'+fmt(c.end))}</div></div>`).join('');
    if(!t.finished&&t.waitStart) html+=`<div class="gantt-row utility-row"><div class="gantt-label">Ожидание минимального срока</div><div class="gantt-timeline">${dayBackgrounds}${bar(t.waitStart,t.waitEnd,'waiting','Без учебных часов')}</div></div>`;
    if(!t.finished) html+=`<div class="gantt-row utility-row"><div class="gantt-label">${t.ReserveDays} дня запаса</div><div class="gantt-timeline">${dayBackgrounds}${bar(t.reserveStart,t.end,'reserve','Запас')}</div></div>`;
    return html;
  }).join('');
  $('gantt').innerHTML = head+deadlineRows+tracks;
}
function renderModules() {
  $('modules-view').innerHTML = `<table class="module-table"><thead><tr><th>Модуль</th><th class="hours-col">Часы</th><th class="date-col">Даты</th><th>Статус</th><th>Прогресс</th></tr></thead><tbody>${visibleTracks().map(t=>`<tr class="group-heading"><td colspan="5">${colors[t.Id][2]} · ${escape(t.Title)}</td></tr>${t.courses.map(c=>`<tr class="${selected===c.Id?'selected':''}" data-course="${c.Id}"><td><button class="module-title" data-select="${c.Id}">${escape(c.Title)}</button></td><td class="hours-col">${c.Hours}</td><td class="date-col">${fmt(c.start)}–${fmt(c.end)}</td><td><span class="tag ${c.status}">${statusName(c)}</span></td><td>${c.status==='completed'?'100%':`<input class="progress-input" type="number" min="0" max="100" value="${c.progress}" aria-label="Прогресс ${escape(c.Title)}" data-progress="${c.Id}"> %`}</td></tr>`).join('')}`).join('')}</tbody></table>` + (data.state.Program==='general'?'<div class="empty-program"><strong>Предпринимательство: список курсов ещё не добавлен</strong>Технологический план и его прогресс сохранены. Можно вернуться к нему через настройки.</div>':'');
}
function renderSelected() {
  const c = getCourse(selected); if (!c) {$('selection-panel').innerHTML='Выбери модуль в календаре.';return;}
  const track=data.schedule.tracks.find(t=>t.Id===c.TrackId);
  const completedDate=c.completedAt?new Date(c.completedAt).toLocaleDateString('ru-RU',{timeZone:'Asia/Qyzylorda'}):null;
  const included=c.IncludedCourses || [];
  const bundle=included.length>1?'Отметка означает завершение всех '+included.length+' курсов этого блока.':'';
  const coverage=c.CreditPlanRole==='additional'?'Дополнительный блок сверх расчёта кредитов.':'';
  const availability=c.Availability==='unconfirmed'?'Доступность не подтверждена. Если курс не открывается, отложи этот блок и продолжи остальные.':'';
  const courseList=included.length>1?`<details class="included-courses"><summary>Курсы внутри блока (${included.length})</summary><ul>${included.map(x=>`<li>${escape(x.Title)}${x.InCreditPlan?'':' <span>Дополнительный</span>'}</li>`).join('')}</ul></details>`:'';
  const gate=!c.canComplete&&c.active&&c.status==='planned'?'Начало модуля — '+fmt(c.start,{day:'numeric',month:'long'})+'.':!c.canComplete&&c.active&&track.courses.filter(x=>x.status!=='completed'&&x.status!=='deferred').length===1&&c.status!=='completed'?'Завершение предмета — не раньше '+fmt(track.earliest,{day:'numeric',month:'long'})+'.':'';
  const deferButton=c.Availability==='unconfirmed'&&c.status!=='completed'?`<button class="button subtle" data-defer="${c.Id}" data-value="${c.status!=='deferred'}">${c.status==='deferred'?'Вернуть в план':'Отложить недоступный блок'}</button>`:'';
  const completionButton=c.status==='completed'
    ? `<button class="button subtle" data-uncomplete="${c.Id}" aria-haspopup="dialog" aria-controls="complete-dialog" aria-label="Убрать отметку о прохождении ${escape(c.Title)}">Убрать отметку</button>`
    : `<button class="button primary" data-complete="${c.Id}" aria-haspopup="dialog" aria-controls="complete-dialog" ${!c.canComplete?'disabled':''}>Модуль пройден</button>`;
  $('selection-panel').innerHTML=`<div class="selected-copy"><strong>${escape(c.Title)}</strong><p>${completedDate?'Фактически пройден '+completedDate:fmt(c.start)+' — '+fmt(c.end)+' · '+c.Hours+' ч · '+statusName(c)}${bundle?'<br>'+bundle:''}${coverage?'<br>'+coverage:''}${availability?'<br>'+availability:''}${gate?'<br>'+gate:''}</p>${courseList}</div><div class="selected-actions"><a class="button subtle" href="${escape(c.Url)}" target="_blank" rel="noopener">Открыть модуль</a>${deferButton}${completionButton}</div>`;
}
function renderView() {
  $('calendar-view').hidden=view!=='calendar';$('modules-view').hidden=view!=='modules';
  document.querySelectorAll('[data-view]').forEach(button=>button.classList.toggle('active',button.dataset.view===view));
}
function openSettings() {
  dirtySettings=false;
  const first=data.originalTracks[0];
  $('start-date').value=data.state.TrackPlanStart?.[first.Id]||data.plan.StartDate;
  $('track-date-fields').innerHTML=data.originalTracks.map(t=>`<div class="track-date-row"><label for="date-${t.Id}">${colors[t.Id][2]}</label><input id="date-${t.Id}" type="date" min="2020-01-01" max="2100-12-31" required data-track-date="${t.Id}" value="${data.state.TrackPlanStart?.[t.Id]||data.plan.StartDate}"></div>`).join('');
  document.querySelector(`input[name="program"][value="${data.state.Program||'technological'}"]`).checked=true;
  const deadlines=importantDates(data.plan,data.state);
  $('subscription-end-date').value=deadlines.subscriptionEndDay===null?'':dateISO(deadlines.subscriptionEndDay);
  $('application-start-date').value=deadlines.applicationStartDay===null?'':dateISO(deadlines.applicationStartDay);
  $('application-end-date').value=deadlines.applicationEndDay===null?'':dateISO(deadlines.applicationEndDay);
  $('settings-dialog').showModal();
}
async function enableNotifications() {
  if (!('Notification' in window)) {showToast('Открой календарь в Chrome, Edge или Safari с поддержкой уведомлений.');return;}
  // Request directly from the user gesture, before any unrelated async work.
  const permission=await Notification.requestPermission();
  try {
    if(permission==='granted') {
      await action({type:'notifications',enabled:true});
      $('notification-invite').hidden=true;showToast('Напоминания включены. Оставь календарь открытым.');
    }
    else if(permission==='denied') showToast('Браузер запретил уведомления. Разрешение можно изменить в настройках сайта у адресной строки.');
    else showToast('Разрешение пока не выбрано. Напоминания выключены.');
  } catch(error){showToast(error.message);}
}
async function displayNotification(payload){
 if(Notification.permission!=='granted')throw new Error('Уведомления запрещены браузером.');
 if(swRegistration?.active)await swRegistration.showNotification(payload.title,{body:payload.body,icon:new URL('./favicon.svg',location.href).href,tag:'coursera-study-reminder',data:{url:payload.url}});
 else {const n=new Notification(payload.title,{body:payload.body,tag:'coursera-study-reminder'});n.onclick=()=>window.open(payload.url,'_blank','noopener');}
}
async function checkReminder(){
 if(!data)return;
 let claimed;
 try{
  if(data.state.NotificationsEnabled&&Notification.permission!=='granted'){await action({type:'notifications',enabled:false});return;}
  claimed=await claimReminder(plan);if(!claimed)return;
  if(claimed.reminder)await displayNotification(claimed.reminder);
 }catch(error){showToast(error.message);}finally{if(claimed)await load();}
}
document.addEventListener('click',async event=>{
  if(isCourseEditor(event.target))return;
  const button=event.target.closest('button,[data-select]');
  const selectId=button?.dataset.select||(!button&&courseRow(event.target)?.dataset.course);
  if(!button&&!selectId)return;
  try {
    if(selectId){if(event.detail>1)return;if(selected!==selectId)await action({type:'select',id:selectId});return;}
    if(button.dataset.view){view=button.dataset.view;renderView();return;}
    if(button.dataset.filter){$('track-filter').value=button.dataset.filter;render();return;}
    if(button.dataset.defer){await action({type:'defer',id:button.dataset.defer,value:button.dataset.value==='true'});showToast(button.dataset.value==='true'?'Блок отложен. Его прогресс и даты сохранены.':'Блок возвращён в план.');return;}
    if(button.dataset.complete||button.dataset.uncomplete){
      completeMode=button.dataset.uncomplete?'uncomplete':'complete';
      completeId=button.dataset.uncomplete||button.dataset.complete;
      const c=getCourse(completeId);if(!c)throw new Error('Неизвестный модуль.');
      const removing=completeMode==='uncomplete';
      $('complete-title').textContent=removing?'Убрать отметку?':'Отметить прохождение?';
      $('complete-description').textContent=removing?'Убрать отметку о прохождении «'+c.Title+'»?':c.IncludedCourses?.length>1?'Все '+c.IncludedCourses.length+' курсов блока «'+c.Title+'» завершены?':'Ты завершил «'+c.Title+'» в Coursera?';
      $('complete-note').textContent=removing?'Снимается только отметка этого модуля. Даты плана и отметки остальных модулей сохранятся.':'Отметка сохранится. Даты плана и длина полосы модуля не изменятся.';
      $('complete-confirm').textContent=removing?'Да, убрать отметку':'Да, модуль пройден';
      $('complete-dialog').showModal();return;
    }
    switch(button.id){
      case 'retry-load':if(await load())button.hidden=true;break;
      case 'export-progress':{const blob=new Blob([JSON.stringify({schema:1,exportedAt:new Date().toISOString(),state:data.state},null,2)],{type:'application/json'});const link=document.createElement('a');link.href=URL.createObjectURL(blob);link.download='my-study-progress.json';link.click();setTimeout(()=>URL.revokeObjectURL(link.href),1000);break;}
      case 'important-dates-edit':case 'settings-open':case 'settings-top':case 'pending-program-settings':case 'pending-card-settings':openSettings();break;
      case 'settings-close':$('settings-dialog').close();break;
      case 'settings-reset':$('settings-dialog').close();$('reset-dialog').showModal();break;
      case 'reset-cancel':$('reset-dialog').close();break;
      case 'reset-confirm':await action({type:'reset'});$('reset-dialog').close();showToast('Твой план сброшен. Начало — сегодня, прогресс — 0.');break;
      case 'complete-cancel':$('complete-dialog').close();break;
      case 'complete-confirm':await action({type:completeMode,id:completeId});$('complete-dialog').close();showToast(completeMode==='uncomplete'?'Отметка снята. Остальные модули и даты сохранены.':'Прохождение сохранено. Даты плана не изменились.');break;
      case 'invite-close':$('notification-invite').hidden=true;sessionStorage.setItem('invite-dismissed','yes');break;
      case 'invite-enable':await enableNotifications();break;
      case 'notifications-enable':data.state.NotificationsEnabled?openSettings():await enableNotifications();break;
      case 'notification-test':await action({type:'test'});await load();showToast('Проверочное уведомление отправлено.');break;
      case 'pause-button':await action({type:data.state.SnoozeUtc&&new Date(data.state.SnoozeUtc)>new Date()?'resume':'pause'});showToast(data.state.SnoozeUtc?'Пауза на час сохранена.':'Напоминания возобновлены.');break;
      case 'notifications-disable':await action({type:'notifications',enabled:false});$('settings-dialog').close();showToast('Напоминания выключены.');break;
      case 'selected-module-button':{const c=getCourse(selected);if(!c)break;weekStart=c.start;$('track-filter').value=c.TrackId;$('all-plan').checked=false;view='calendar';render();document.querySelector('.gantt-row.selected')?.scrollIntoView({block:'nearest'});break;}
      case 'today-button':weekStart=data.schedule.today;if(data.schedule.today<calendarStart||data.schedule.today>calendarEnd)$('all-plan').checked=false;renderCalendar();if($('all-plan').checked){const scroll=$('gantt-scroll');const width=parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--day-width'));scroll.scrollLeft=Math.max(0,(data.schedule.today-calendarStart-2)*width);}break;
      case 'previous-week':case 'next-week':$('all-plan').checked=false;weekStart=(weekStart??data.schedule.today)+(button.id==='next-week'?7:-7);renderCalendar();break;
    }
  }catch(error){showToast(error.message);}
});
document.addEventListener('dblclick',event=>{
  if(event.button!==0||isCourseEditor(event.target))return;
  const row=courseRow(event.target),c=row&&getCourse(row.dataset.course);
  if(!c)return;
  event.preventDefault();
  window.open(c.Url,'_blank','noopener,noreferrer');
});
document.addEventListener('change',async event=>{
  const input=event.target;
  if(input.id==='track-filter'){render();return;}
  if(input.id==='all-plan'){renderCalendar();renderModules();return;}
  if(input.id==='start-date'){document.querySelectorAll('[data-track-date]').forEach(el=>el.value=input.value);dirtySettings=true;return;}
  if(input.dataset.trackDate){dirtySettings=true;return;}
  if(input.dataset.progress){try{await action({type:'progress',id:input.dataset.progress,value:Number(input.value)});showToast('Прогресс сохранён.');}catch(error){showToast(error.message);await load();}}
});
$('settings-form').addEventListener('submit',async event=>{
  event.preventDefault();
  const entries=[...document.querySelectorAll('[data-track-date]')].map(el=>({id:el.dataset.trackDate,value:el.value}));
  const program=document.querySelector('input[name="program"]:checked').value;
  try {
    await action({type:'settings',program,SubscriptionEndDate:$('subscription-end-date').value||null,ApplicationStartDate:$('application-start-date').value||null,ApplicationEndDate:$('application-end-date').value||null,dates:dirtySettings?entries.filter(entry=>entry.value!==(data.state.TrackPlanStart?.[entry.id]||data.plan.StartDate)):[]});
    $('settings-dialog').close();showToast('Настройки сохранены. Календарь пересчитан.');
  }catch(error){showToast(error.message);}
});
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'&&plan){load();checkReminder();}});
async function registerWebMCP() {
  if(!document.modelContext?.registerTool)return;
  const controller=new AbortController();
  const tools=[
    {
      name:'read_study_plan',title:'Прочитать учебный план',
      description:'Read the current calendar, progress and settings without changing them.',
      inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true},
      execute:async()=>({program:data.state.Program,tracks:data.schedule.tracks.map(t=>({
        id:t.Id,title:t.Title,start:dateISO(t.start),end:dateISO(t.end),
        courses:t.courses.map(c=>({id:c.Id,title:c.Title,status:c.status,start:dateISO(c.start),end:dateISO(c.end)}))
      }))})
    },
    {
      name:'select_study_module',title:'Выбрать модуль',
      description:'Select a module to show its details in the calendar. Does not mark completion or open an external course.',
      inputSchema:{type:'object',properties:{id:{type:'string'}},required:['id'],additionalProperties:false},annotations:{readOnlyHint:false},
      execute:async input=>{if(typeof input?.id!=='string'||!getCourse(input.id))throw new Error('Неизвестный модуль.');await action({type:'select',id:input.id});return{selected:input.id};}
    }
  ];
  for(const tool of tools)try{await document.modelContext.registerTool(tool,{signal:controller.signal});}catch{}
  addEventListener('pagehide',()=>controller.abort(),{once:true});
}
async function init() {
  try {
    if(sessionStorage.getItem('invite-dismissed'))$('notification-invite').hidden=true;
    plan=await (await fetch('./plan.json?v=6',{cache:'no-cache'})).json();
    if('serviceWorker' in navigator){navigator.serviceWorker.register('./sw.js').then(()=>navigator.serviceWorker.ready).then(r=>{swRegistration=r;}).catch(()=>{});}
    if(await load())registerWebMCP();
    setInterval(load,30000);setInterval(checkReminder,15000);
  }catch(error){$('connection-error').textContent='Не удалось открыть профиль. Разреши хранение данных для этого сайта и обнови страницу.';$('connection-error').hidden=false;}
}
init();
