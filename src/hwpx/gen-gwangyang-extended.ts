import { measureTextWidth, faceClassForGen } from "./text-metrics.js"
import { fitGwangyangText } from "./gen-gwangyang-fit.js"
/** 감동시대 보고서 D08 머리표, D13 표지, D24 둥근상자 실측 구조. */
import type { GwangyangBlock } from "./gen-gwangyang-block.js"
import { type FrameCtx, ftbl, host } from "./gen-frame-seoul.js"
import { tc, para } from "./gen-gongmun-extra.js"
import type { ImageRegistry } from "./gen-image.js"
import { type CellBfSpec } from "./gen-table-bf.js"
import { GWANGYANG_VISION_9, GWANGYANG_SUNSHINE, GWANGYANG_EMBLEM } from "./gwangyang-brand-assets.js"
import { localTitle } from "./gen-frame-local.js"
import { generateParagraph } from "./md-runs.js"
import { inlineMapper } from "./style-registry.js"

const none:CellBfSpec = {t:"none",b:"none",l:"none",r:"none"}
const seq = new WeakMap<FrameCtx,number>()
function rect(ctx:FrameCtx,w:number,h:number,text:string,tab=false,floating=false,topGap=1300,textTop=1600):string {
  const id=1900000000+(seq.get(ctx)??0)+1;seq.set(ctx,id-1900000000)
  return `<hp:rect xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core" id="${id}" zOrder="${floating?2:1}" numberingType="NONE" textWrap="${floating?'IN_FRONT_OF_TEXT':'TOP_AND_BOTTOM'}" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" href="" groupLevel="0" instid="${id}" ratio="${tab?20:3}">`
    +`<hp:offset x="0" y="0"/><hp:orgSz width="${w}" height="${h}"/><hp:curSz width="${w}" height="${h}"/><hp:flip horizontal="0" vertical="0"/><hp:rotationInfo angle="0" centerX="${Math.round(w/2)}" centerY="${Math.round(h/2)}" rotateimage="1"/>`
    +`<hp:renderingInfo><hc:transMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/><hc:scaMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/><hc:rotMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/></hp:renderingInfo>`
    +`<hp:lineShape color="${tab?'#3057B9':'#004B8E'}" width="85" style="SOLID" endCap="ROUND" headStyle="NORMAL" tailStyle="NORMAL" headfill="1" tailfill="1" headSz="SMALL_SMALL" tailSz="SMALL_SMALL" outlineStyle="NORMAL" alpha="0"/><hc:fillBrush><hc:winBrush faceColor="${tab?'#DFE6F7':'#FFFFFF'}" hatchColor="#000000" alpha="0"/></hc:fillBrush><hp:shadow type="NONE" color="#B2B2B2" offsetX="0" offsetY="0" alpha="0"/>`
    +`<hp:drawText lastWidth="${w}" name="" editable="1"><hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="CENTER" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">${text}</hp:subList><hp:textMargin left="${tab?280:1100}" right="${tab?280:1100}" top="${tab?140:textTop}" bottom="${tab?140:1000}"/></hp:drawText>`
    +`<hc:pt0 x="0" y="0"/><hc:pt1 x="${w}" y="0"/><hc:pt2 x="${w}" y="${h}"/><hc:pt3 x="0" y="${h}"/><hp:sz width="${w}" widthRelTo="ABSOLUTE" height="${h}" heightRelTo="ABSOLUTE" protect="0"/>`
    +`<hp:pos treatAsChar="${floating?0:1}" affectLSpacing="0" flowWithText="1" allowOverlap="${floating?1:0}" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="${floating?'COLUMN':'PARA'}" vertAlign="TOP" horzAlign="${floating?'CENTER':'LEFT'}" vertOffset="0" horzOffset="0"/><hp:outMargin left="0" right="0" top="${floating?0:topGap}" bottom="500"/><hp:shapeComment>${tab?'제목 탭':'둥근 설명상자'}</hp:shapeComment></hp:rect>`
}

export function roundedBox(block:GwangyangBlock,ctx:FrameCtx,minHeight=0):string {
  const {reg,W}=ctx,w=W-1500, style={font:"휴먼명조",pt:15,bold:false}
  const rows=block.body??[]
  const fitted=rows.map(t=>fitGwangyangText(t,style.font,style.pt,w-2200,ctx))
  const lines=fitted.reduce((n,f)=>n+f.lines,0)
  const tabWidth=Math.round(w/3),fit=fitGwangyangText(block.title,"맑은 고딕",14,tabWidth-560,ctx,true)
  const tabH=block.variant === "tab" ? Math.max(2800,fit.lines*1400+560) : 2800
  const top=Math.max(1600,tabH/2+200)
  const h=Math.max(minHeight,lines*2550+rows.length*300+top+1000)
  // 도형은 한글에서 쪽 분할되지 않는다. 폰트 축소나 잘림 대신 명시적으로 분할 요청.
  if(h>(block.type === "institution-cover" ? 32000 : 50000)) throw new Error("gwangyang 둥근 상자가 한 쪽 높이를 초과합니다. body를 여러 rounded-box로 나누세요")
  const body=rows.map((t,i)=>{
    const f=fitted[i],st={...style,ratio:f.ratio,spacing:f.spacing}
    return generateParagraph(t,reg.para({lineSp:170,after:300,keepWord:f.keepWord,widowOrphan:true}),reg.char(st),inlineMapper(reg,st))
  }).join("")
  const shape=rect(ctx,w,h,body,false,false,tabH/2,top)
  const tab=block.variant === "tab" ? rect(ctx,tabWidth,tabH,para(block.title,reg.para({align:"CENTER",lineSp:100}),reg.char({font:"맑은 고딕",pt:14,ratio:fit.ratio,spacing:fit.spacing,bold:true})),true,true) : ""

  return host(shape+tab,reg.para({align:"CENTER",lineSp:100,after:1000}),reg.char({font:"맑은 고딕",pt:1}))
}

export function buildGwangyangExtended(block:GwangyangBlock,ctx:FrameCtx,images:ImageRegistry|null):string {
  if(block.type === "rounded-box") return roundedBox(block,ctx)
  if(!images) throw new Error("광양시 머리표·표지에는 이미지 레지스트리가 필요합니다")
  const {reg,bf,W}=ctx
  const cp=reg.char({font:"맑은 고딕",pt:11}), pp=reg.para({align:"CENTER",lineSp:100})
  const empty=para("",pp,reg.char({font:"맑은 고딕",pt:1}))
  const picture=(uri:string,w:number):string=>{
    const part=images.take(uri)
    if(!part?.wHU || !part.hHU) throw new Error("광양시 로고 등록 실패")
    return host(images.inlinePicXml({...part,wHU:w,hHU:Math.round(w*part.hHU/part.wHU)}),pp,cp)
  }
  const cell=(row:number,col:number,w:number,h:number,text:string,spec:CellBfSpec=none,extra={})=>{
    const xml=tc({row,col,w,h,paras:text,bf:bf.get(spec),...extra})
    return text.includes("<hp:tbl ") ? xml.replace('hasMargin="0"','hasMargin="1"').replace(/<hp:cellMargin left="141" right="141" top="141" bottom="141"\/>(?=<\/hp:tc>$)/, '<hp:cellMargin left="0" right="0" top="0" bottom="0"/>') : xml
  }
  const textFit=(text:string,font:string,pt:number,width:number,align:"CENTER"|"LEFT"|"DISTRIBUTE"="CENTER",lineSp=110,pad=0)=>{
    const f=fitGwangyangText(text,font,pt,width,ctx,true)
    return {xml:para(text,reg.para({align:align === "DISTRIBUTE" && f.lines>1 ? "LEFT" : align,lineSp,left:pad,right:pad,keepWord:true}),reg.char({font,pt,ratio:f.ratio,spacing:f.spacing})),height:f.lines*pt*lineSp+282}
  }
  if(block.type === "staff-header") {
    // D08 원본: 20173×3976HU, 날짜 1382 + 담당자 2594, 직위열 11501.
    // 로고는 본문 왼쪽 끝(9865HU), 담당자 표는 오른쪽 끝. 가운데 세로선 유지.
    const right=Math.round(W*20173/47904),logoW=Math.round(W*9865/47904),gap=W-right-logoW
    const staff=block.staff??[],rw=Math.round(right*11501/20173)
    const roleFits=staff.map(s=>textFit(s.role,"HY울릉도M",11,rw-1420,"DISTRIBUTE",110,200))
    const nameFits=staff.map(s=>{
      const width=right-rw-1420,combined=textFit(`${s.name}(${s.phone})`,"HY울릉도M",11,width,"CENTER",110,200)
      if(combined.height<=1492) return combined
      const name=textFit(s.name,"HY울릉도M",11,width,"CENTER",110,200),phone=textFit(`(${s.phone})`,"HY울릉도M",11,width,"CENTER",110,200)
      return {xml:name.xml+phone.xml,height:name.height+phone.height-282}
    })
    const dateFit=textFit(block.date??"","HY울릉도M",11,right-1020,"CENTER",90)
    const rh=Math.max(staff.length*1212+170,staff.reduce((n,_,i)=>n+Math.max(roleFits[i].height,nameFits[i].height)-282,0)+170),dh=Math.max(1382,dateFit.height)
    const hc=reg.char({font:"HY울릉도M",pt:11})
    const dateP=reg.para({align:"CENTER",lineSp:90})
    const roleP=reg.para({align:"DISTRIBUTE",left:200,right:200,lineSp:110})
    const nameP=reg.para({align:"CENTER",left:200,right:200,lineSp:110})
    const edge:CellBfSpec={t:"thin",b:"thin",l:"thin",r:"thin"}
    const dash=["0.12 mm","#000000","DASH"] as const
    const headerCell=(row:number,col:number,w:number,h:number,text:string,spec:CellBfSpec,extra={})=>
      cell(row,col,w,h,text,spec,extra).replace('hasMargin="0"','hasMargin="1"').replace('<hp:cellMargin left="141" right="141" top="141" bottom="141"/>','<hp:cellMargin left="510" right="510" top="141" bottom="141"/>')
    const rowHeights=staff.map((_,i)=>Math.max(1212,roleFits[i].height-282,nameFits[i].height-282)+85)
    const staffHeight=rowHeights.reduce((a,b)=>a+b,0)
    const logo=picture(GWANGYANG_VISION_9,logoW).replace(`paraPrIDRef="${pp}"`,`paraPrIDRef="${reg.para({align:"LEFT",lineSp:100})}"`)
    // 중첩 표의 셀 경계에서 오른쪽·아래 획이 잘리지 않도록 단일 표로 배치한다.
    const rows=[
      cell(0,0,logoW,dh+staffHeight,logo,none,{rowSpan:staff.length+1})
      +cell(0,1,gap,dh+staffHeight,empty,none,{rowSpan:staff.length+1})
      +headerCell(0,2,right,dh,dateFit.xml,{...edge,b:[...dash]},{colSpan:2}),
      ...staff.map((_,i)=>{
        const spec:CellBfSpec={...edge,t:i===0?[...dash]:"none",b:i===staff.length-1?"thin":"none"}
        return headerCell(i+1,2,rw,rowHeights[i],roleFits[i].xml,spec)+headerCell(i+1,3,right-rw,rowHeights[i],nameFits[i].xml,spec)
      }),
    ].map(row=>row.replace(/hasMargin="0"/g,'hasMargin="1"').replace(/<hp:cellMargin left="141" right="141" top="141" bottom="141"\/>/g,'<hp:cellMargin left="0" right="0" top="0" bottom="0"/>'))
    return host(ftbl(rows,W,dh+staffHeight,4),reg.para({lineSp:100,after:500,keepWithNext:true}),hc)
  }
  const logos=cell(0,0,14000,4200,picture(GWANGYANG_SUNSHINE,11500))+cell(0,1,W-28000,4200,empty)+cell(0,2,14000,4200,picture(GWANGYANG_VISION_9,13000))
  const top=host(ftbl([logos],W,4200,3),reg.para({lineSp:100,after:500}),cp)
  const mw=13000,gap=4000,aw=W-mw-gap,ml=4000
  const edge:CellBfSpec={t:"thin",b:"thin",l:"thin",r:"thin"}
  const pairs=[["문서번호",block.documentNumber??""],["보존기간",block.retention??""],["결재일자",block.date??""],["공개여부",block.disclosure??""]]
  const metaFits=pairs.map(([label,value])=>[textFit(label,"맑은 고딕",9,ml-282),textFit(value,"맑은 고딕",11,mw-ml-282)])
  const metaHeights=metaFits.map(([a,b])=>Math.max(2100,a.height,b.height)),metaHeight=metaHeights.reduce((a,b)=>a+b,0)
  const meta=ftbl(metaFits.map(([a,b],i)=>cell(i,0,ml,metaHeights[i],a.xml,{...edge,fill:"#E7EFF7"})+cell(i,1,mw-ml,metaHeights[i],b.xml,edge)),mw,metaHeight,2)
  const roles=block.approvers??["담당자","팀장","과장","국장","부시장"]
  const widths=roles.map((_,i)=>i===roles.length-1 ? aw-Math.floor(aw/roles.length)*(roles.length-1) : Math.floor(aw/roles.length))
  const roleFits=roles.map((v,i)=>textFit(v,"맑은 고딕",11,widths[i]-282))
  const roleHeight=Math.max(2500,...roleFits.map(f=>f.height))
  const approval=ftbl([roles.map((v,i)=>cell(0,i,widths[i],roleHeight,roleFits[i].xml,{...edge,fill:"#E7EFF7"})).join(""),roles.map((_,i)=>cell(1,i,widths[i],5900,empty,edge)).join("")],aw,roleHeight+5900,roles.length)
  const metadataHeight=Math.max(metaHeight,roleHeight+5900)+200
  const metadata=host(ftbl([cell(0,0,mw,metadataHeight,host(meta,pp,cp))+cell(0,1,gap,metadataHeight,empty)+cell(0,2,aw,metadataHeight,host(approval,pp,cp))],W,metadataHeight,3),reg.para({lineSp:100,after:2800}),cp)
  const title=localTitle(block.title,"gwangyang-1",ctx,images,{subtitle:block.subtitle,color:"#263056",pt:24}).xml
  const summary=roundedBox({...block,variant:"plain"},ctx,26000)
  const cityText="광  양  시"
  const cityWidth=Math.min(14718,Math.ceil(measureTextWidth(cityText,2600,100,{faceClass:faceClassForGen(ctx.frame.titleFont)})))
  const dept=block.dept??"",deptFit=fitGwangyangText(dept,ctx.frame.titleFont,14,cityWidth,ctx,true)
  const deptXml=para(dept,reg.para({align:deptFit.lines>1?"LEFT":"DISTRIBUTE",right:14718-cityWidth,lineSp:110,keepWord:true}),reg.char({font:ctx.frame.titleFont,pt:14,ratio:deptFit.ratio,spacing:deptFit.spacing}))
  const bottom=host(ftbl([cell(0,0,6500,6000,picture(GWANGYANG_EMBLEM,5200))+cell(0,1,15000,6000,para(cityText,reg.para({align:"LEFT",lineSp:110}),reg.char({font:ctx.frame.titleFont,pt:26,bold:true}))+deptXml)],21500,6000,2),reg.para({align:"CENTER",lineSp:100,before:600}),cp)
  return top+metadata+title+summary+bottom
}
