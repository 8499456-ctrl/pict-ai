(function(){
  const languages=[
    ['en','English'],['zh','中文'],['es','Español'],['fr','Français'],['pt','Português'],
    ['ja','日本語'],['ko','한국어'],['ar','العربية'],['de','Deutsch']
  ];
  const nav={
    en:{home:'Home',comic:'Photo to Comic',remove:'Remove Background',travel:'Travel Photo to Art',compress:'Image Compressor',resize:'Resize & Crop',poster:'Product Poster'},
    zh:{home:'首页',comic:'照片转漫画',remove:'去除背景',travel:'旅行照片转艺术',compress:'图片压缩',resize:'改尺寸与裁剪',poster:'商品海报'},
    es:{home:'Inicio',comic:'Foto a comic',remove:'Quitar fondo',travel:'Foto de viaje a arte',compress:'Compresor',resize:'Redimensionar',poster:'Poster de producto'},
    fr:{home:'Accueil',comic:'Photo en BD',remove:'Supprimer le fond',travel:'Photo de voyage en art',compress:'Compresseur',resize:'Redimensionner',poster:'Affiche produit'},
    pt:{home:'Inicio',comic:'Foto para HQ',remove:'Remover fundo',travel:'Foto de viagem em arte',compress:'Compressor',resize:'Redimensionar',poster:'Poster de produto'},
    ja:{home:'ホーム',comic:'写真をコミックに',remove:'背景削除',travel:'旅行写真をアートに',compress:'画像圧縮',resize:'リサイズ',poster:'商品ポスター'},
    ko:{home:'홈',comic:'사진을 만화로',remove:'배경 제거',travel:'여행 사진 아트',compress:'이미지 압축',resize:'크기 조정',poster:'상품 포스터'},
    ar:{home:'الرئيسية',comic:'صورة إلى كوميكس',remove:'إزالة الخلفية',travel:'صورة السفر إلى فن',compress:'ضغط الصور',resize:'تغيير الحجم',poster:'ملصق منتج'},
    de:{home:'Start',comic:'Foto zu Comic',remove:'Hintergrund entfernen',travel:'Reisefoto zu Kunst',compress:'Bildkompressor',resize:'Zuschneiden',poster:'Produktposter'}
  };
  const zh={
    'photo-to-comic':{title:'照片在线转漫画 | PictTool',description:'用 PictTool 把头像、宠物、旅行照或日常照片变成漫画风插画。',eyebrow:'AI 漫画效果',h1:'把照片变成漫画插画',lead:'上传头像或日常照片，生成彩色漫画风结果，同时尽量保留主体识别度。',primary:'试试照片转漫画',secondary:'查看步骤',before:'处理前',after:'处理后',footer:'PictTool · 免费 AI 图片工具',sections:[['适合头像、宠物、旅行照和社交头像','当你想让照片更有表现力，但又不想完全重画主体时，PictTool 的漫画肖像工具很适合。清晰、有光线、主体占比足的照片效果更稳定。',[['适合头像','生成更友好的插画头像、社交图片和缩略图。'],['保留识别度','提示词会尽量保留脸、衣服、姿势和构图。'],['不用设计软件','上传、生成、预览、下载都在浏览器里完成。']]],['如何把照片变成漫画','',null,[['选择清晰图片','头像、宠物、旅行照或合影都可以，光线越好越稳定。'],['打开漫画肖像','上传图片，如需要可补充一句风格说明。'],['下载结果','保存漫画风图片，用于帖子、Pin、头像或创意素材。']],'生成漫画肖像'],['照片转漫画常见问题','',null,null,null,[['合影可以用吗？','可以。清晰合影能处理，但近距离头像通常更容易保留脸部细节。'],['什么照片效果最好？','主体居中、画面清晰、光线足的照片更适合。避免严重模糊或脸太小。'],['可以免费试用吗？','PictTool 提供每日免费额度，可先测试效果再决定要做什么。']]]]},
    'remove-background':{title:'在线免费去除图片背景 | PictTool',description:'上传 JPG、PNG 或 WebP，用 PictTool 快速去除背景，生成干净抠图。',eyebrow:'背景去除',h1:'在线免费去除图片背景',lead:'为商品图、人像或社交图片制作干净抠图。上传图片后，PictTool 会自动去除背景。',primary:'去除背景',secondary:'适合用途',before:'处理前',after:'处理后',footer:'PictTool · 免费 AI 图片工具',sections:[['适合商品、头像和快速设计的干净抠图','透明或简洁背景能让主体更突出，适合商品列表、缩略图、头像图和社交帖子。',[['商品照片','为网店、目录和促销图准备更干净的图片。'],['人物头像','从杂乱背景中分离人物，再做海报或头像。'],['设计素材','用于演示文稿、帖子、缩略图和拼贴。']]],['如何去除背景','',null,[['上传图片','选择主体清楚的 JPG、PNG 或 WebP。'],['让 AI 识别主体','PictTool 自动把主体和背景分离。'],['下载抠图','保存结果，用在你的设计或商品图里。']],'试试背景去除'],['背景去除常见问题','',null,null,null,[['商品图可以用吗？','可以。主体清晰、对比明显的照片通常效果最好。'],['需要账号吗？','不需要。PictTool 的基础免费工具可以直接试用。'],['哪些图片要避免？','避免非常模糊、主体和背景颜色太接近、或前景细节太小的图片。']]]]},
    'travel-photo-to-art':{title:'旅行照片转艺术图 | PictTool',description:'把旅行照片、建筑和地标照片变成插画风旅行艺术图。',eyebrow:'旅行照片艺术',h1:'把旅行照片变成插画风艺术图',lead:'让地标、街景和旅行回忆像明信片一样更有表现力。上传旅行照片，在线生成艺术版本。',primary:'生成旅行艺术图',secondary:'创意用途',before:'处理前',after:'处理后',footer:'PictTool · 免费 AI 图片工具',sections:[['让旅行记忆更适合分享','旅行照片常有很好的主体，但光线普通或背景杂乱。艺术化转换可以把地标照片做成明信片、墙面装饰、相册封面或 Pinterest 图片。',[['地标明信片','把寺庙、街道、海边和城市景观变成旅行插画。'],['社交封面','为 Pinterest、博客、短视频和旅行收藏板制作醒目图片。'],['个人收藏','把不同旅程做成统一风格的艺术记忆。']]],['如何创建旅行艺术图','',null,[['选择旅行照片','建筑、街景、户外照片和形状清晰的地标最适合。'],['打开旅行照片转艺术','使用简短提示词，如 watercolor postcard、soft ink lines。'],['下载并分享','用于 Pin、博客图片、相册封面或打印灵感。']],'试试旅行照片转艺术'],['旅行照片转艺术常见问题','',null,null,null,[['建筑照片可以转吗？','可以。建筑、纪念碑、街景和风景通常形状明确，效果不错。'],['提示词怎么写？','可以试试 watercolor postcard、hand-painted travel poster、soft ink illustration。'],['可以发 Pinterest 吗？','可以，前提是你拥有原图权利。旅行图前后对比很适合展示转换效果。']]]]},
    'image-compressor':{title:'在线免费图片压缩 | PictTool',description:'在浏览器中压缩 JPG、PNG、WebP，或转换图片格式。',eyebrow:'图片压缩',h1:'分享前在线压缩图片',lead:'在浏览器里压缩 JPG、PNG 和 WebP，让图片更容易上传、发送、发布和发到 Pinterest。',primary:'压缩图片',secondary:'查看步骤',footer:'PictTool · 免费 AI 图片工具',metrics:['原始文件','示例压缩后','下载前选择格式'],sections:[['适合网站、邮件和社交媒体的小文件','大图片会拖慢上传速度，也会让网页更重。PictTool 压缩工具适合在分享前做一个更轻的版本。',[['博客和网站图片','发布文章或页面前先减小图片体积。'],['社交帖子','为 Pinterest、Instagram、Facebook 等平台准备图片。'],['格式转换','按需要下载为 JPG、PNG 或 WebP。']]],['如何压缩图片','',null,[['上传图片','从设备选择 JPG、PNG 或 WebP。'],['选择格式和质量','质量越低文件越小，质量越高细节越多。'],['下载结果','保存压缩后的图片，用在需要小文件的地方。']],'试试图片压缩'],['图片压缩常见问题','',null,null,null,[['图片会上传到服务器吗？','快速压缩工具在浏览器本地运行，图片留在你的设备上。'],['应该选择哪种格式？','照片适合 JPG；需要透明背景可用 PNG；网页通常 WebP 更小。'],['压缩会降低画质吗？','会。文件越小通常细节越少，建议选择能满足用途的最高质量。']]]]},
    'resize-crop-image':{title:'在线免费改尺寸与裁剪图片 | PictTool',description:'为 Pinterest、Instagram、YouTube 等平台裁剪图片尺寸。',eyebrow:'改尺寸与裁剪',h1:'为社交媒体裁剪图片尺寸',lead:'制作适合 Pinterest、Instagram、YouTube 等平台的图片比例。在浏览器里裁剪并下载可分享版本。',primary:'裁剪图片',secondary:'常用尺寸',footer:'PictTool · 免费 AI 图片工具',tags:['Pinterest 2:3','方图 1:1'],sections:[['一张图片，多种常用比例','不同平台需要不同尺寸。干净裁剪能让主体保持可见，避免上传后被平台裁掉。',[['Pinterest Pin','适合搜索和收藏板的竖版图片。'],['方形帖子','适合头像、商品预览和信息流。'],['横版缩略图','适合 YouTube 封面、博客头图和预览图。']]],['如何改尺寸和裁剪','',null,[['上传照片','从设备选择 JPG、PNG 或 WebP。'],['选择裁剪比例','选择常用社交尺寸，或使用原图比例。'],['下载裁剪结果','保存成可用于帖子、Pin 或缩略图的图片。']],'试试改尺寸与裁剪'],['改尺寸与裁剪常见问题','',null,null,null,[['裁剪会上传图片吗？','不会。快速裁剪工具在浏览器本地运行，图片留在你的设备上。'],['Pinterest 用什么尺寸？','竖版 2:3 是常用起点。'],['可以裁剪 Instagram 吗？','可以。方形和竖版比例适合很多 Instagram 内容。']]]]},
    'product-poster':{
      title:'免费商品海报模板 | PictTool',
      description:'上传商品图片，制作 4:5 商品海报，添加标题、副标题和价格。',
      eyebrow:'商品海报模板',
      h1:'快速制作可分享的商品海报',
      lead:'上传商品图，添加标题、副标题和价格，直接生成适合 Pinterest、网店和社交平台的 4:5 海报。',
      primary:'制作商品海报',
      secondary:'使用建议',
      footer:'PictTool · 免费 AI 图片工具',
      sections:[
        ['适合小商品、课程、下载资源和促销图片','商品海报工具在浏览器本地运行，不消耗 AI 次数。它适合快速做清爽的分享图，而不是复杂设计稿。',[
          ['4:5 海报比例','适合 Pinterest、Instagram 竖版帖子和商品展示。'],
          ['本地处理','图片留在浏览器里，不上传服务器。'],
          ['可先去背景','先用去背景工具处理商品，再做海报会更干净。']
        ]],
        ['如何制作商品海报','',null,[
          ['上传商品图片','最好选择背景简单、主体清楚的图片。'],
          ['填写文字和价格','输入标题、副标题和价格，选择模板风格。'],
          ['下载海报','保存 JPG，用于帖子、商品图或 Pinterest。']
        ],'开始制作商品海报'],
        ['商品海报常见问题','',null,null,null,[
          ['这个工具收费吗？','当前建议免费开放，因为它是本地工具，不消耗 AI 成本。'],
          ['适合什么图片？','商品主体清晰、背景简单的图片效果最好。'],
          ['可以先去背景吗？','可以，先去背景再做海报，画面会更干净。']
        ]]
      ]
    }
  };
  const topOnly={
    es:{'travel-photo-to-art':{eyebrow:'Arte de viaje',h1:'Convierte fotos de viaje en arte ilustrado',lead:'Haz que monumentos, calles y recuerdos parezcan postales ilustradas.',primary:'Crear arte de viaje',secondary:'Ideas creativas'},'product-poster':{eyebrow:'Poster de producto',h1:'Crea un poster de producto listo para compartir',lead:'Sube una imagen de producto, añade titulo, subtitulo y precio, y descarga un poster 4:5.',primary:'Crear poster',secondary:'Consejos'},'photo-to-comic':{eyebrow:'Efecto comic IA',h1:'Convierte tu foto en una ilustracion comic',lead:'Sube una foto y crea un resultado colorido manteniendo el sujeto reconocible.',primary:'Probar foto a comic',secondary:'Como funciona'},'remove-background':{eyebrow:'Quitar fondo',h1:'Quita fondos de imagen gratis online',lead:'Crea un recorte limpio para productos, retratos o publicaciones.',primary:'Quitar fondo',secondary:'Mejores usos'},'image-compressor':{eyebrow:'Compresor de imagen',h1:'Comprime imagenes antes de compartir',lead:'Reduce JPG, PNG y WebP directamente en tu navegador.',primary:'Comprimir imagen',secondary:'Como funciona'},'resize-crop-image':{eyebrow:'Redimensionar y cortar',h1:'Recorta imagenes para redes sociales',lead:'Prepara tamanos para Pinterest, Instagram, YouTube y mas.',primary:'Redimensionar imagen',secondary:'Tamanos populares'}},
    fr:{'travel-photo-to-art':{eyebrow:'Art de voyage',h1:'Transformez vos photos de voyage en art illustre',lead:'Donnez a vos monuments, rues et souvenirs un style de carte postale.',primary:'Creer une image de voyage',secondary:'Idees'},'product-poster':{eyebrow:'Affiche produit',h1:'Creez une affiche produit prete a partager',lead:'Ajoutez titre, sous-titre et prix puis telechargez une affiche 4:5.',primary:'Creer une affiche',secondary:'Conseils'}},
    pt:{'travel-photo-to-art':{eyebrow:'Arte de viagem',h1:'Transforme fotos de viagem em arte ilustrada',lead:'Deixe monumentos, ruas e memorias com estilo de postal ilustrado.',primary:'Criar arte de viagem',secondary:'Ideias'},'product-poster':{eyebrow:'Poster de produto',h1:'Crie um poster de produto pronto para compartilhar',lead:'Adicione titulo, subtitulo e preco e baixe um poster 4:5.',primary:'Criar poster',secondary:'Dicas'}},
    ja:{'travel-photo-to-art':{eyebrow:'旅行写真アート',h1:'旅行写真をイラスト風アートに',lead:'名所、街並み、旅の思い出をポストカードのような雰囲気にします。',primary:'旅行アートを作成',secondary:'アイデア'},'product-poster':{eyebrow:'商品ポスター',h1:'共有しやすい商品ポスターを作成',lead:'商品画像に見出し、説明、価格を追加して4:5ポスターを作れます。',primary:'ポスターを作成',secondary:'ヒント'}},
    ko:{'travel-photo-to-art':{eyebrow:'여행 사진 아트',h1:'여행 사진을 일러스트 아트로 바꾸기',lead:'랜드마크와 거리, 여행 추억을 엽서 같은 이미지로 만듭니다.',primary:'여행 아트 만들기',secondary:'아이디어'},'product-poster':{eyebrow:'상품 포스터',h1:'공유하기 좋은 상품 포스터 만들기',lead:'상품 이미지에 제목, 설명, 가격을 넣어 4:5 포스터를 만듭니다.',primary:'포스터 만들기',secondary:'팁'}},
    ar:{'travel-photo-to-art':{eyebrow:'فن صور السفر',h1:'حوّل صور السفر إلى فن مرسوم',lead:'اجعل المعالم والشوارع والذكريات تبدو كبطاقات سفر مرسومة.',primary:'إنشاء فن سفر',secondary:'أفكار'},'product-poster':{eyebrow:'ملصق منتج',h1:'أنشئ ملصق منتج جاهزاً للمشاركة',lead:'ارفع صورة منتج وأضف عنواناً ووصفاً وسعراً ثم حمّل ملصقاً بنسبة 4:5.',primary:'إنشاء ملصق',secondary:'نصائح'}},
    de:{'travel-photo-to-art':{eyebrow:'Reisekunst',h1:'Verwandle Reisefotos in illustrierte Kunst',lead:'Mache Sehenswuerdigkeiten, Strassen und Erinnerungen zu Postkartenbildern.',primary:'Reisekunst erstellen',secondary:'Ideen'},'product-poster':{eyebrow:'Produktposter',h1:'Erstelle ein teilbares Produktposter',lead:'Lade ein Produktbild hoch, ergaenze Titel, Untertitel und Preis und speichere ein 4:5 Poster.',primary:'Poster erstellen',secondary:'Tipps'}}
  };
  const enDefaults={before:'Before',after:'After',footer:'PictTool · Free AI image tools'};
  function key(){return location.pathname.split('/').filter(Boolean)[0]||'photo-to-comic'}
  function set(selector,value,root=document){const node=root.querySelector(selector);if(node&&value)node.textContent=value}
  function applySections(content){
    if(!content.sections)return;
    document.querySelectorAll('section.section').forEach((section,index)=>{
      const item=content.sections[index];if(!item)return;
      set('h2',item[0],section);set(':scope > p',item[1],section);
      if(item[2])section.querySelectorAll('.card').forEach((card,i)=>{set('strong',item[2][i]?.[0],card);set('p',item[2][i]?.[1],card)});
      if(item[3])section.querySelectorAll('.step').forEach((step,i)=>{set('strong',item[3][i]?.[0],step);set('p',item[3][i]?.[1],step)});
      set('.cta-band .primary',item[4],section);
      if(item[5])section.querySelectorAll('details').forEach((detail,i)=>{set('summary',item[5][i]?.[0],detail);set('p',item[5][i]?.[1],detail)});
    });
  }
  function contentFor(lang,page){
    const base=Object.assign({},enDefaults);
    const full=lang==='zh'?zh[page]:null;
    const lite=topOnly[lang]&&topOnly[lang][page];
    return Object.assign(base,full||{},lite||{});
  }
  function apply(lang){
    const page=key(),content=contentFor(lang,page),n=nav[lang]||nav.en;
    document.documentElement.lang=lang;document.documentElement.dir=lang==='ar'?'rtl':'ltr';
    if(content.title)document.title=content.title;
    const meta=document.querySelector('meta[name="description"]');if(meta&&content.description)meta.setAttribute('content',content.description);
    document.querySelectorAll('.nav-links a').forEach(a=>{
      const href=a.getAttribute('href')||'';
      if(href==='../')a.textContent=n.home;
      else if(href.includes('photo-to-comic'))a.textContent=n.comic;
      else if(href.includes('remove-background'))a.textContent=n.remove;
      else if(href.includes('travel-photo-to-art'))a.textContent=n.travel;
      else if(href.includes('image-compressor'))a.textContent=n.compress;
      else if(href.includes('resize-crop-image'))a.textContent=n.resize;
      else if(href.includes('product-poster'))a.textContent=n.poster;
    });
    set('.eyebrow',content.eyebrow);set('h1',content.h1);set('.lead',content.lead);
    set('.actions .primary',content.primary);set('.actions .secondary',content.secondary);
    const labels=document.querySelectorAll('.label');if(labels[0]&&content.before)labels[0].textContent=content.before;if(labels[1]&&content.after)labels[1].textContent=content.after;
    if(content.metrics)document.querySelectorAll('.metric span').forEach((node,i)=>{if(content.metrics[i])node.textContent=content.metrics[i]});
    if(content.tags)document.querySelectorAll('.tag').forEach((node,i)=>{if(content.tags[i])node.textContent=content.tags[i]});
    applySections(content);set('footer',content.footer);
    localStorage.setItem('pict-language',lang);
    document.querySelectorAll('.subpage-language').forEach(select=>{select.value=lang});
  }
  function mount(){
    if(!document.querySelector('.subpage-l10n-style')){
      const style=document.createElement('style');style.className='subpage-l10n-style';
      style.textContent='.subpage-language{color:var(--muted);background:rgba(255,255,255,.06);border:1px solid var(--line);border-radius:999px;padding:7px 10px;font:inherit;font-size:12px;max-width:132px}.nav-inner{flex-wrap:wrap}html[dir="rtl"] body{text-align:right}html[dir="rtl"] .hero,html[dir="rtl"] footer{text-align:center}html[dir="rtl"] .step::before{left:auto;right:20px}@media(max-width:760px){.subpage-language{margin-left:auto}}';
      document.head.appendChild(style);
    }
    const navInner=document.querySelector('.nav-inner');if(navInner&&!document.querySelector('.subpage-language')){
      const select=document.createElement('select');select.className='subpage-language';select.setAttribute('aria-label','Select language');
      languages.forEach(([value,label])=>{const option=document.createElement('option');option.value=value;option.textContent=label;select.appendChild(option)});
      select.addEventListener('change',()=>apply(select.value));navInner.appendChild(select);
    }
    apply(localStorage.getItem('pict-language')||document.documentElement.lang||'en');
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mount,{once:true});else mount();
})();
