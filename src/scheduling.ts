import {addDay,dateSchema} from './core';

const dateToken='(?<![\\d./-])(?:\\d{4}-\\d{2}-\\d{2}|\\d{1,2}[-/.]\\d{1,2}(?![\\d./-])|(?:\\d{4}\\s*年\\s*)?\\d{1,2}\\s*月\\s*\\d{1,2}\\s*[日号]?|\\d{1,2}\\s*[日号]|大后天|后天|明天|今天|(?:(?:下下|下|本|这)?周|星期|礼拜)[一二三四五六日天1-7])';

function expandDates(text:string):string {
  // Expand shared units before tokenization: 16~18日, 10月16至18号, 17和18号.
  return text.replace(/((?:\d{4}年)?\d{1,2}月)?(\d{1,2})\s*[~～至—–]\s*(\d{1,2})\s*([日号])/g,(all,prefix,a,b,unit)=>{
    const from=Number(a),to=Number(b);if(from<1||to>31||to<from)return all;
    return Array.from({length:to-from+1},(_,i)=>`${prefix??''}${from+i}${unit}`).join('、');
  }).replace(/(\d{1,2}(?:\s*[、和及]\s*\d{1,2})+)\s*([日号])/g,(_,nums,unit)=>nums.replace(/\d{1,2}/g,(n:string)=>n+unit));
}

export function hasSchedulingHint(text:string):boolean {
  text=text.split(/[，,。；;\n]/).filter(s=>!/(?:不要|不应|不能|别|无需|不必).*(?:安排|推迟|延期|放到|挪到)/.test(s)).join('\n');
  text=text.replace(new RegExp('(?:📅|截止(?:日期|时间|日)?|最迟|deadline|due)\\s*(?:在|到|为|是)?\\s*'+dateToken,'gi'),'')
    .replace(new RegExp(dateToken+'\\s*(?:前(?:完成|提交|交付)?|之前|截止|到期)','g'),'');
  return /未来|以后|后续日期|改期|下个月|周末|月底|下旬|中旬|上旬|\d{1,2}[-/.]\d{1,2}|\d{1,2}\s*[日号]/.test(text);
}

// A deadline constrains completion, not the day work should start.
export function scheduleDates(text:string,sourceDay:string):string[] {
  const withoutDeadlines=expandDates(text).split(/[，,。；;\n]/).filter(s=>!/(?:不要|不应|不能|别|无需|不必).*(?:安排|推迟|延期|放到|挪到)/.test(s)).join('\n')
    .replace(new RegExp('(?:📅|截止(?:日期|时间|日)?|最迟|deadline|due)\\s*(?:在|到|为|是)?\\s*'+dateToken,'gi'),'')
    .replace(new RegExp('(?:不是|不在|而非|并非|别在)\\s*'+dateToken,'g'),'')
    .replace(new RegExp(dateToken+'\\s*(?:前(?:完成|提交|交付)?|之前|截止|到期)','g'),'');
  const found=new Set<string>();
  for(const match of withoutDeadlines.matchAll(new RegExp(dateToken,'g'))) {
    const token=match[0].replace(/\s/g,'');let date:string|undefined;
    if(/^\d{4}-/.test(token))date=token;
    else {
      const literal=/^(?:(\d{4})年)?(\d{1,2})[月./-](\d{1,2})[日号]?$/.exec(token);
      if(literal)date=`${literal[1]??sourceDay.slice(0,4)}-${literal[2].padStart(2,'0')}-${literal[3].padStart(2,'0')}`;
      else if(/^\d{1,2}[日号]$/.test(token))date=`${sourceDay.slice(0,7)}-${token.slice(0,-1).padStart(2,'0')}`;
      else if(['今天','明天','后天','大后天'].includes(token))date=addDay(sourceDay,['今天','明天','后天','大后天'].indexOf(token));
      else {
        const weekday='一二三四五六日天'.indexOf(token.at(-1)!);
        const desired=/[1-7]$/.test(token)?Number(token.at(-1))-1:weekday===7?6:weekday;
        const current=(new Date(sourceDay+'T12:00:00Z').getUTCDay()+6)%7;
        let shift=desired-current;
        if(token.startsWith('下下'))shift+=14;else if(token.startsWith('下'))shift+=7;
        else if(!/^[本这]/.test(token)&&shift<0)shift+=7;
        date=addDay(sourceDay,shift);
      }
    }
    if(date&&dateSchema.safeParse(date).success)found.add(date);
  }
  return [...found];
}

export function explicitClocks(text:string):string[] {
  const digits:Record<string,number>={零:0,一:1,二:2,两:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9};
  text=text.replace(/[零一二两三四五六七八九十]+(?=[点时])/g,s=>{
    const parts=s.split('十');return String(parts.length===2?(parts[0]?digits[parts[0]]:1)*10+(digits[parts[1]]??0):digits[s]??s);
  });
  const times=new Set<string>();
  for(const m of text.matchAll(/\b([01]?\d|2[0-3]):([0-5]\d)\b/g))times.add(`${m[1].padStart(2,'0')}:${m[2]}`);
  for(const m of text.matchAll(/(上午|下午|晚上|中午)?\s*(\d{1,2})\s*[点时](?:(\d{1,2})分?)?/g)) {
    let h=Number(m[2]);if(['下午','晚上'].includes(m[1])&&h<12)h+=12;
    const minutes=Number(m[3]??0);if(h<24&&minutes<60)times.add(`${String(h).padStart(2,'0')}:${String(minutes).padStart(2,'0')}`);
  }
  return [...times];
}

export function namedFeedback(feedback:string[],names:string[]):string[] {
  const labels=names.map(s=>s.replace(/^\d{2}:\d{2}(?:\s*[-–—]\s*\d{2}:\d{2})?\s*/,'').replace(/（优先）|📅\s*\d{4}-\d{2}-\d{2}/g,'').trim()).filter(s=>s.length>=2);
  return feedback.flatMap(s=>s.split(/[。！？!?\n；;，,]/)).filter(clause=>labels.some(name=>clause.includes(name)));
}
