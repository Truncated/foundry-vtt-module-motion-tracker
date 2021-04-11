import * as settings from './settings.js'

export class MotionTrackerDevice
{
	static PIXILoader = null;
	// BEGIN SHADER BLOCK
	static signalFunc = '\
	float signal(float x)\
	{\
		x = fract(x);\
		return max(\
			fract(3.*x)*min(1., floor(3.*fract(x))),\
			 floor(.5*(ceil(3.*x)-1.))\
			 );\
	}\
	';
	static fragShaderBackground = '\
		varying vec2 vTextureCoord;\
		uniform sampler2D uSampler;\
		uniform float time;\
		uniform float speed;\
		uniform float centerx;\
		uniform float centery;\
		'+MotionTrackerDevice.signalFunc+'\
		void main(void)\
		{\
			vec4 tex = texture2D(uSampler, vTextureCoord);\
			vec2 d = normalize(vTextureCoord-vec2(0.5));\
			float s = signal(speed*time);\
			s = s>0.05?(tex.a*pow(clamp(1.-length(vTextureCoord-(s*d+vec2(0.5)))-.75, 0., 1.)*4., 16.)):0.;\
	   		gl_FragColor = mix(vec4(tex.rgb, 1.), vec4(1.), s);\
		}';
	static vertShaderPing = '\
		attribute vec2 aVertexPosition;\
		attribute vec2 aTextureCoord;\
		\
		uniform mat3 projectionMatrix;\
		\
		varying vec2 vTextureCoord;\
		varying vec2 vWorldCoord;\
		\
		void main(void)\
		{\
			vWorldCoord = aVertexPosition;\
			gl_Position = vec4((projectionMatrix * vec3(aVertexPosition, 1.0)).xy, 0.0, 1.0);\
			vTextureCoord = aTextureCoord;\
		}';
	static fragShaderPing = '\
		varying vec2 vTextureCoord;\
		varying vec2 vWorldCoord;\
		uniform sampler2D uSampler;\
		uniform float time;\
		uniform float speed;\
		uniform float centerx;\
		uniform float centery;\
		'+MotionTrackerDevice.signalFunc+'\
		void main(void)\
		{\
			vec2 c = vec2(centerx, centery);\
			vec2 cp = vWorldCoord-c;\
			vec2 d = normalize(cp);\
			float s = 2.*signal(speed*time);\
			s = s*length(c*d)>length(cp)?1.:0.;\
			gl_FragColor = s*texture2D(uSampler, vTextureCoord).rrrr;\
		}';
	// END SHADER BLOCK
	static uniformsBackground = {time: 0., speed: 0.01, centerx: 0., centery: 0., uSampler: null};
	static uniforms = {time: 0., speed: 0.01, centerx: 0., centery: 0.};

	static SCREEN_ADDITIONAL_TEXEL_HEIGHT = 64;
	static SCREEN_ADDITIONAL_CANVAS_HEIGHT = 64./1024;

	constructor(element_container, config)
	{
		MotionTrackerDevice.uniforms.time = 0.0;
		MotionTrackerDevice.uniformsBackground.time = 0.0;
		//private variables
		this.container = element_container;
		this.dimensions = config.dimensions;
		this.config = config;
		this.tokenReference = null;

		this.user = null;

		this.signals = [];
		this.signalsMax = 20;

		const SIZE = game.settings.get(settings.REGISTER_CODE, 'size');
		
		const distanceMax = game.settings.get(settings.REGISTER_CODE,'maxDistance');
		// TODO distUnitPerPx in 2D, see TODO investigate in signals position computation
		this.distUnitPerPx = 0.8*settings.MAX_SIZE*.5/distanceMax;

		this.soundBank = {};
		// Renderer specific
		this.pixi = {
			app: null,
			sprite_background: null,
			sprites_signals: [],
			filter_background: new PIXI.Filter(undefined, MotionTrackerDevice.fragShaderBackground, MotionTrackerDevice.uniforms),
			filter_ping: new PIXI.Filter(MotionTrackerDevice.vertShaderPing, MotionTrackerDevice.fragShaderPing, MotionTrackerDevice.uniforms),
			distanceMessage: new PIXI.Text('',{fontFamily : 'Roboto', fontSize: Math.max(12, 32*(SIZE-settings.MIN_SIZE)/(settings.MAX_SIZE-settings.MIN_SIZE)), fontWeight: 'bold', fill : 0x994d1a, align : 'center'})
		};

		this.ready = false;

		// data
		this.textures = {
			background: 'modules/motion_tracker/textures/motion_tracker_background.png',
			ping: 'modules/motion_tracker/textures/motion_tracker_ping.webp',
		};
		this.loadTextures();
	}

	preloadSounds()
	{
		let foundsounds = [];// TODO: 'scanning', 'close','medium','far'];
		foundsounds.forEach(v => 
		{
			let path = `modules/motion_tracker/sounds/${v}.wav`;
			AudioHelper.play({
				src: path,
				autoplay: false
			}, false);
			this.soundBank[v] = path;
		});
	}

	loadTextures()
	{
		if(MotionTrackerDevice.PIXILoader === null)
		{
			MotionTrackerDevice.PIXILoader =  new PIXI.Loader();
			MotionTrackerDevice.PIXILoader
			.add([this.textures.background, this.textures.ping])
			.load(this.loadTexturesFinish.bind(this));
		}
		else
		{
			this.loadTexturesFinish(); // simply apply the end process
		}
	}

	async loadTexturesFinish()
	{
		const SIZE = game.settings.get(settings.REGISTER_CODE, 'size');
		
		const distanceMax = game.settings.get(settings.REGISTER_CODE,'maxDistance');
		this.distUnitPerPx = 0.8*SIZE*.5/distanceMax;

		//Create the `cat` sprite
		PIXI.utils.TextureCache[this.textures.background].baseTexture.alphaMode = PIXI.ALPHA_MODES.NO_PREMULTIPLIED_ALPHA;
		PIXI.utils.TextureCache[this.textures.background].baseTexture.update();
		if(this.pixi.sprite_background===null)
		{
			MotionTrackerDevice.uniformsBackground.uSampler = PIXI.utils.TextureCache[this.textures.background];
			const backgroundShdr = PIXI.Shader.from(null, MotionTrackerDevice.fragShaderBackground, MotionTrackerDevice.uniformsBackground);
			const QuadGeometry = new PIXI.Geometry()
			    .addAttribute('aVertexPosition', // the attribute name
				[
					0, 0, // x, y
					SIZE, 0, // x, y
					SIZE, SIZE+MotionTrackerDevice.SCREEN_ADDITIONAL_CANVAS_HEIGHT,
					0, SIZE+MotionTrackerDevice.SCREEN_ADDITIONAL_CANVAS_HEIGHT
				], // x, y
				2) // the size of the attribute
			    .addAttribute('aTextureCoord', // the attribute name
				[
					0, 0, // u, v
					1, 0, // u, v
					1, 1,
					0, 1
				], // u, v
				2) // the size of the attribute
			    .addIndex([0, 1, 2, 0, 2, 3]);
			this.pixi.sprite_background = new PIXI.Mesh(QuadGeometry, backgroundShdr);
		}
		
		this.pixi.sprite_background.x = 0;
		this.pixi.sprite_background.y = 0;

		if(this.pixi.sprites_signals.length==0)
		{
			for(let i = 0;i<this.signalsMax;++i)
			{
				this.pixi.sprites_signals[i] = new PIXI.Sprite(PIXI.utils.TextureCache[this.textures.ping]);
				this.pixi.sprites_signals[i].x = 0;
				this.pixi.sprites_signals[i].y = 0;
				this.pixi.sprites_signals[i].anchor.set(0.5, 0.5);
				this.pixi.sprites_signals[i].visible = false;
				this.pixi.sprites_signals[i].filters = [this.pixi.filter_ping];
				this.pixi.sprites_signals[i].width = Math.max(32, SIZE/32*this.distUnitPerPx);
				this.pixi.sprites_signals[i].height = Math.max(32, SIZE/32*this.distUnitPerPx);
			}
		}
	      
		//Add the cat to the stage so you can see it

		this.ready = true;

		await this.container!==null;

		// PIXI context creation
		if(this.pixi.app === null)
		{
			this.pixi.app = new PIXI.Application({width: SIZE, height: SIZE+MotionTrackerDevice.SCREEN_ADDITIONAL_CANVAS_HEIGHT});
		}
		
		this.pixi.app.stage.removeChildren();

		this.container.appendChild(this.pixi.app.view);

		// setup base
		this.pixi.app.renderer.backgroundColor = 0x000000;
		
		this.pixi.sprite_background.blendMode = PIXI.BLEND_MODES.ADD;
		this.pixi.app.stage.addChild(this.pixi.sprite_background);
		for(let i = 0;i<this.pixi.sprites_signals.length;++i)
		{
			this.pixi.app.stage.addChild(this.pixi.sprites_signals[i]);
		}
		this.pixi.distanceMessage.anchor.set(0.5, 0.5);
		this.pixi.app.stage.addChild(this.pixi.distanceMessage);
		this.pixi.app.ticker.add(this.update, this);
	}

	async reset()
	{
		return new Promise(resolve => {
				this.loadTexturesFinish();
				resolve();
			}
		);
	}

	resize(size)
	{
		if(this.pixi.app && this.pixi.app.render)
		{
			this.pixi.app.renderer.autoDensity = true;
			this.pixi.app.renderer.resize(size, size+MotionTrackerDevice.SCREEN_ADDITIONAL_CANVAS_HEIGHT);
		}
	}

	playSound(sound)
	{
		let volume = sound[1] * this.volume;
		AudioHelper.play({
			src: sound[0],
			volume: volume
		}, false);
	}

	update(delta)
	{
		if(this.user===null || this.tokenReference===null)
			return;
		// wipe precedent signals
		this.signals.length = 0;

		function computeTokenCenter(token)
		{
			return {
				x:0.5*token.scale*token.width+token.x,
				y:0.5*token.scale*token.height+token.y
			};
		}

		const scene = game.scenes.get(this.viewedSceneId);
		const tokens = scene.data.tokens;
		const seePlayers = game.settings.get(settings.REGISTER_CODE,'seePlayers');
		const distanceMax = game.settings.get(settings.REGISTER_CODE,'maxDistance');
		const immobileStatuses = [CONFIG.Combat.defeatedStatusId, 'unconscious', 'asleep', 'stunned', 'paralysis']
		const pos = computeTokenCenter(this.tokenReference);
		let nearestDist = distanceMax;
		tokens.forEach(token => 
			{
				let immobile = token.actorData?.effects?.find(e => immobileStatuses.some(s=>s===e.flags.core.statusId));
				
				if(!immobile && token._id!==this.tokenReference._id && !token.hidden)
				{
					const oPos = computeTokenCenter(token);
					oPos.x = (oPos.x-pos.x)/scene.data.grid;
					oPos.y = (oPos.y-pos.y)/scene.data.grid;
					const normDir = Math.sqrt(oPos.x*oPos.x+oPos.y*oPos.y);
					let scanResult = { distance: scene.data.gridDistance*normDir, dir: { x: oPos.x/normDir, y: oPos.y/normDir } };
					nearestDist = Math.min(nearestDist, scanResult.distance);
					if(scanResult.distance<distanceMax)
						this.signals.push(scanResult);
				}
			});
		const centerCanvas = {x: .5*this.pixi.app.stage.width, y:.5*this.pixi.app.stage.width }; // no longer height due to additional space, the MT is square
		for(let i = 0;i<this.pixi.sprites_signals.length;++i)
		{
			if(i<this.signals.length)
			{
				this.pixi.sprites_signals[i].visible = true;
				this.pixi.sprites_signals[i].x = this.distUnitPerPx*this.signals[i].dir.x*this.signals[i].distance+centerCanvas.x;
				// 0.944, background is not really square, TODO investigate
				this.pixi.sprites_signals[i].y = this.distUnitPerPx*this.signals[i].dir.y*this.signals[i].distance+0.944*centerCanvas.y;
			}
			else
				this.pixi.sprites_signals[i].visible = false;
		}
		this.pixi.distanceMessage.x = centerCanvas.x;
		this.pixi.distanceMessage.y = this.pixi.app.stage.height-5.-32.*(this.pixi.app.stage.width-settings.MIN_SIZE)/(settings.MAX_SIZE-settings.MIN_SIZE);
		
		let x = MotionTrackerDevice.uniforms.time*MotionTrackerDevice.uniforms.speed;
		x = Math.ceil(3.*(x-Math.trunc(x)))-1.;

		if(x>0.0)
			this.pixi.distanceMessage.text = nearestDist.toFixed(2)+scene.data.gridUnits;

		MotionTrackerDevice.uniformsBackground.time += delta;
		MotionTrackerDevice.uniformsBackground.centerx = centerCanvas.x;
		MotionTrackerDevice.uniformsBackground.centery = centerCanvas.y;
		MotionTrackerDevice.uniforms.time+=delta;
		MotionTrackerDevice.uniforms.centerx = centerCanvas.x;
		MotionTrackerDevice.uniforms.centery = centerCanvas.y;
	}

	setData(user = game.user, tokenId, viewedSceneId)
	{
		this.user = user;
		this.tokenReference = null;
		this.viewedSceneId = viewedSceneId;
		const scene = game.scenes.get(this.viewedSceneId);
		const tokens = scene.data.tokens;
		if(tokens.length>0)
			this.tokenReference = tokens.find(tok => tok._id === tokenId);
	}

	stop()
	{
		this.pixi.app.ticker.stop();
		this.pixi.app.ticker.destroy();
	}
}