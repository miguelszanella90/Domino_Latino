const { Redis } = require('@upstash/redis');
const kv = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN
});
const id=()=>Math.random().toString(36).slice(2,8).toUpperCase();
const set=()=>{let a=[];for(let i=0;i<=6;i++)for(let j=i;j<=6;j++)a.push([i,j]);return a.sort(()=>Math.random()-.5)};
async function save(g){await kv.set(`domino:${g.code}`,g,{ex:86400})}
module.exports=async(req,res)=>{try{let b=req.body||{}, action=b.action; if(req.method==='GET'){let g=await kv.get(`domino:${req.query.code}`);return res.status(g?200:404).json(g||{error:'Sala no encontrada'});}
if(action==='create'){let code=id(),tiles=set(),pid=id(),g={code,host:pid,maxPlayers:+b.maxPlayers||4,target:+b.target||100,turnDirection:b.turnDirection||'clockwise',players:[{id:pid,name:b.name||'Jugador 1',hand:[]}],board:[],boneyard:tiles,scores:{},turn:0,status:'lobby',message:'Sala creada'};await save(g);return res.json({game:g,playerId:pid});}
let g=await kv.get(`domino:${b.code}`);if(!g)return res.status(404).json({error:'Sala no encontrada'});
if(action==='join'){if(g.players.length>=g.maxPlayers)return res.status(400).json({error:'Sala llena'});let pid=id();g.players.push({id:pid,name:b.name||`Jugador ${g.players.length+1}`,hand:[]});await save(g);return res.json({game:g,playerId:pid});}
if(action==='start'){if(b.playerId!==g.host)return res.status(403).json({error:'Solo el host puede iniciar'});let n=g.players.length, count=n===4?7:7;g.players.forEach(p=>p.hand=g.boneyard.splice(0,count));let best={p:0,v:-1};g.players.forEach((p,pi)=>p.hand.forEach((t,ti)=>{if(t[0]===t[1]&&t[0]>best.v)best={p:pi,ti,v:t[0]}}));g.turn=best.v>=0?best.p:0;g.status='playing';g.message=`Turno de ${g.players[g.turn].name}`;await save(g);return res.json(g)}
let pi=g.players.findIndex(p=>p.id===b.playerId);if(pi<0)return res.status(403).json({error:'Jugador inválido'});if(pi!==g.turn)return res.status(400).json({error:'No es tu turno'});
const next=()=>{g.turn=(g.turn+(g.turnDirection==='clockwise'?1:g.players.length-1))%g.players.length;g.message=`Turno de ${g.players[g.turn].name}`};
if(action==='draw'){if(!g.boneyard.length)return res.status(400).json({error:'El pozo está vacío'});g.players[pi].hand.push(g.boneyard.pop());await save(g);return res.json(g)}
if(action==='pass'){next();await save(g);return res.json(g)}
if(action==='play'){let t=g.players[pi].hand[b.tileIndex];if(!t)return res.status(400).json({error:'Ficha inválida'});let placed=t;if(!g.board.length){g.board.push(t)}else{let left=g.board[0][0],right=g.board[g.board.length-1][1];if(b.side==='left'){if(t[1]===left)placed=t;else if(t[0]===left)placed=[t[1],t[0]];else return res.status(400).json({error:'No coincide con el extremo izquierdo'});g.board.unshift(placed)}else{if(t[0]===right)placed=t;else if(t[1]===right)placed=[t[1],t[0]];else return res.status(400).json({error:'No coincide con el extremo derecho'});g.board.push(placed)}g.players[pi].hand.splice(b.tileIndex,1);if(!g.players[pi].hand.length){let pts=g.players.reduce((s,p)=>s+p.hand.flat().reduce((a,x)=>a+x,0),0);g.scores[g.players[pi].id]=(g.scores[g.players[pi].id]||0)+pts;g.status='finished';g.message=`¡Dominó! ${g.players[pi].name} gana la ronda (+${pts})`;}else next();await save(g);return res.json(g)}
return res.status(400).json({error:'Acción inválida'});}catch(e){res.status(500).json({error:e.message})}}
