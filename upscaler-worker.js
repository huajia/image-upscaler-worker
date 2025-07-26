/* 
=========================================================================
== upscaler-worker.js
=========================================================================
*/

// --- 配置区 
const BLEND_SIZE = 16;


function gen_arch_config() {
    var config = {};

    config["swin_unet"] = {
        art: { color_stability: true, padding: "replication" },
        art_scan: { color_stability: false, padding: "replication" },
        photo: { color_stability: false, padding: "reflection" }
    };
    var swin = config["swin_unet"];
    const calc_tile_size_swin_unet = function (tile_size, config) {
        while (true) {
            if ((tile_size - 16) % 12 == 0 && (tile_size - 16) % 16 == 0) {
                break;
            }
            tile_size += 1;
        }
        return tile_size;
    };
    for (const domain of ["art", "art_scan", "photo"]) {
        var base_config = {
            ...swin[domain],
            arch: "swin_unet", domain: domain, calc_tile_size: calc_tile_size_swin_unet,
            input_name: 'x', 
            output_name: 'y',
            data_format: 'rgb'
        };
        swin[domain] = {
            scale2x: { ...base_config, scale: 2, offset: 16 },
            scale4x: { ...base_config, scale: 4, offset: 32 },
            scale1x: { ...base_config, scale: 1, offset: 8 }, 
        };
        for (var i = 0; i < 4; ++i) {
            swin[domain]["noise" + i + "_scale2x"] = { ...base_config, scale: 2, offset: 16 };
            swin[domain]["noise" + i + "_scale4x"] = { ...base_config, scale: 4, offset: 32 };
            swin[domain]["noise" + i] = { ...base_config, scale: 1, offset: 8 };
        }
    }

    config["cunet"] = { art: {} };
    const calc_tile_size_cunet = function (tile_size, config) {
        var adj = config.scale == 1 ? 16 : 32;
        tile_size = ((tile_size * config.scale + config.offset * 2) - adj) / config.scale;
        tile_size -= tile_size % 4;
        return tile_size;
    };
    var base_config = {
        arch: "cunet", domain: "art", calc_tile_size: calc_tile_size_cunet,
        color_stability: true,
        padding: "replication",
        input_name: 'x', 
        output_name: 'y',
        data_format: 'rgb'
    };
    config["cunet"]["art"] = {
        scale2x: { ...base_config, scale: 2, offset: 36 },
        scale1x: { ...base_config, scale: 1, offset: 28 }, 
    };
    var base = config["cunet"];
    for (var i = 0; i < 4; ++i) {
        base["art"]["noise" + i + "_scale2x"] = { ...base_config, scale: 2, offset: 36 };
        base["art"]["noise" + i] = { ...base_config, scale: 1, offset: 28 };
    }
     config["x4s"] = {
        photo: {} 
    };
    const calc_tile_size_esrgan = function (tile_size, config) {
        return tile_size;
    };
    var esrgan_base_config = {
        arch: "x4s",
        domain: "photo", 
        calc_tile_size: calc_tile_size_esrgan,
        padding: "replication", 
        input_name: 'image', 
        output_name: 'upscaled_image',
        data_format: 'rgb',
        tile_pad: 10
    };

    config["x4s"]["photo"]["x4"] = {
        ...esrgan_base_config,
        scale: 4,
        path: 'https://r2.img.aigent.vip/favicon-196x196.png' 
    };

    return config;
}

const CONFIG = {
    arch: gen_arch_config(),
    get_config: function (arch, style, method) {
        if ((arch in this.arch) && (style in this.arch[arch]) && (method in this.arch[arch][style])) {
            let config = this.arch[arch][style][method];
            if (!("path" in config)) {
                config["path"] = `./models/waifu2x/${arch}/${style}/${method}.onnx`;
            }

            return config;
        } else {
            return null;
        }
    },

    get_helper_model_path: function (name) {
        return `./models/waifu2x/utils/${name}.onnx`;
    }
};


let modelCache = {};

async function loadModel(modelPath) {
    if (modelCache[modelPath]) {
        self.postMessage({ type: 'status', payload: { message: `从缓存加载模型` } });
        return modelCache[modelPath];
    }
    
    const modelName = modelPath.split('/').pop();
    self.postMessage({ type: 'status', payload: { message: `准备下载模型` } });

    const response = await fetch(modelPath);
    if (!response.ok) throw new Error(`模型文件加载失败: ${response.statusText}`);


    const reader = response.body.getReader();
    const totalSize = +response.headers.get('Content-Length'); 
    self.postMessage({ type: 'status', payload: { message: `获取文件总大小` } });
    let loadedSize = 0;
    let chunks = [];
    let lastReportedProgress = -1;

    while (true) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }
        chunks.push(value);
        loadedSize += value.length;
        if (totalSize) {
            const progress = Math.round((loadedSize / totalSize) * 100);
            if (progress > lastReportedProgress) {
                self.postMessage({
                    type: 'model_load_progress',
                    payload: { progress: progress, modelName: modelName }
                });
                lastReportedProgress = progress;
            }
        }
    }

    self.postMessage({ type: 'status', payload: { message: `模型下载完成，正在解析,大概1分钟左右` } });
    const blob = new Blob(chunks);
    const modelBuffer = await blob.arrayBuffer();
    chunks = []; 
    self.postMessage({ type: 'status', payload: { message: `正在加载 AI 核心...` } });
    const session = await ort.InferenceSession.create(modelBuffer, {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all'
    });
    self.postMessage({ type: 'status', payload: { message: `汇编指令加载完成` } });
    modelCache[modelPath] = session;
    return session;
}


const SeamBlending = class {
    constructor(x_size, scale, offset, tile_size, blend_size = BLEND_SIZE) {
        this.x_size = x_size;
        this.scale = scale;
        this.offset = offset;
        this.tile_size = tile_size;
        this.blend_size = blend_size;
    }
    async build() {
        self.postMessage({ type: 'status', payload: { message: `构建无缝拼接方案...` } });
        this.param = SeamBlending.calc_parameters(
            this.x_size, this.scale, this.offset, this.tile_size, this.blend_size);
        self.postMessage({ type: 'status', payload: { message: `参数计算完成` } });
    
        if (this.param.h_blocks <= 0 || this.param.w_blocks <= 0) {
             throw new Error("SeamBlending 参数错误：图块数量非正数");
        }
        self.postMessage({ type: 'status', payload: { message: `创建像素缓冲区...` } });

        this.pixels = new ort.Tensor(
            'float32',
            new Float32Array(this.param.y_buffer_h * this.param.y_buffer_w * 3),
            [3, this.param.y_buffer_h, this.param.y_buffer_w]);
        this.weights = new ort.Tensor(
            'float32',
            new Float32Array(this.param.y_buffer_h * this.param.y_buffer_w * 3),
            [3, this.param.y_buffer_h, this.param.y_buffer_w]);
            self.postMessage({ type: 'status', payload: { message: `加载拼接辅助模型...` } });
        this.blend_filter = await this.create_seam_blending_filter();
        this.output = new ort.Tensor(
            'float32',
            new Float32Array(this.blend_filter.data.length),
            this.blend_filter.dims);
    }
    update(x, tile_i, tile_j) {
        const step_size = this.param.output_tile_step;
        const [C, H, W] = this.blend_filter.dims;
        const HW = H * W;
        const buffer_h = this.pixels.dims[1];
        const buffer_w = this.pixels.dims[2];
        const buffer_hw = buffer_h * buffer_w;
        const h_i = step_size * tile_i;
        const w_i = step_size * tile_j;
        var old_weight, next_weight, new_weight;
        for (var c = 0; c < 3; ++c) {
            for (var i = 0; i < H; ++i) {
                for (var j = 0; j < W; ++j) {
                    var tile_index = c * HW + i * W + j;
                    var buffer_index = c * buffer_hw + (h_i + i) * buffer_w + (w_i + j);
                    old_weight = this.weights.data[buffer_index];
                    next_weight = old_weight + this.blend_filter.data[tile_index];
                    if (next_weight > 0) {
                        old_weight = old_weight / next_weight;
                        new_weight = 1.0 - old_weight;
                        this.pixels.data[buffer_index] = (this.pixels.data[buffer_index] * old_weight +
                            x.data[tile_index] * new_weight);
                    } else {
                        this.pixels.data[buffer_index] = x.data[tile_index]; 
                    }
                    this.weights.data[buffer_index] += this.blend_filter.data[tile_index];
                    this.output.data[tile_index] = this.pixels.data[buffer_index];
                }
            }
        }
        return this.output; 
    }
    get_rendering_config() {
        return this.param;
    }
    static calc_parameters(x_size, scale, offset, tile_size, blend_size) {
        let p = {};
        const x_h = x_size[2];
        const x_w = x_size[3];
        p.y_h = x_h * scale;
        p.y_w = x_w * scale;
        p.input_offset = Math.ceil(offset / scale);
        p.input_blend_size = Math.ceil(blend_size / scale);
        p.input_tile_step = tile_size - (p.input_offset * 2 + p.input_blend_size);
    
        if (p.input_tile_step <= 0) {
            
            const effective_tile_size_for_filter = Math.max(x_h, x_w) + 2 * p.input_offset; 
            p.input_tile_step = Math.max(x_h, x_w); 
            p.output_tile_step = p.input_tile_step * scale;
    
            p.h_blocks = 1;
            p.w_blocks = 1;
    
            const padded_input_h = x_h + 2 * p.input_offset;
            const padded_input_w = x_w + 2 * p.input_offset;
            p.y_buffer_h = padded_input_h * scale;
            p.y_buffer_w = padded_input_w * scale;
            p.pad = [
                p.input_offset,
                padded_input_w - (x_w + p.input_offset),
                p.input_offset,
                padded_input_h - (x_h + p.input_offset)
            ];

            p.effective_tile_size_for_filter = effective_tile_size_for_filter;
            return p; 
        }
    
        p.output_tile_step = p.input_tile_step * scale;
        let [h_blocks, w_blocks, input_h, input_w] = [0, 0, 0, 0];
        while (input_h < x_h + p.input_offset * 2) {
            input_h = h_blocks * p.input_tile_step + tile_size;
            ++h_blocks;
        }
        while (input_w < x_w + p.input_offset * 2) {
            input_w = w_blocks * p.input_tile_step + tile_size;
            ++w_blocks;
        }
        p.h_blocks = h_blocks;
        p.w_blocks = w_blocks;
        p.y_buffer_h = input_h * scale;
        p.y_buffer_w = input_w * scale;
        p.pad = [
            p.input_offset,
            input_w - (x_w + p.input_offset),
            p.input_offset,
            input_h - (x_h + p.input_offset)
        ];
        p.effective_tile_size_for_filter = tile_size;
        return p;
    }
    async create_seam_blending_filter() {
        const ses = await loadModel(CONFIG.get_helper_model_path("create_seam_blending_filter"));

        const tile_size_to_use = this.param.effective_tile_size_for_filter !== undefined ? this.param.effective_tile_size_for_filter : this.tile_size;
        self.postMessage({ type: 'status', payload: { message: `准备输入张量` } });
    
        let scale_tensor = new ort.Tensor('int64', BigInt64Array.from([BigInt(this.scale)]), []);
        let offset_tensor = new ort.Tensor('int64', BigInt64Array.from([BigInt(this.offset)]), []);
        let tile_size_tensor = new ort.Tensor('int64', BigInt64Array.from([BigInt(Math.round(tile_size_to_use))]), []); 

        self.postMessage({ type: 'status', payload: { message: `开始运行模型` } });

        let out;
        try {
            out = await ses.run({
                "scale": scale_tensor,
                "offset": offset_tensor,
                "tile_size": tile_size_tensor,
            });

        } catch (runError) {
            let errorMsg = '未知错误';
            if (runError && runError.message) {
                errorMsg = runError.message;
            } else if (typeof runError === 'string') {
                errorMsg = runError;
            } else if (runError && typeof runError.toString === 'function') {
                errorMsg = runError.toString();
            }
            self.postMessage({ type: 'error', payload: { message: `辅助模型运行失败 (create_seam_blending_filter): ${errorMsg}`, stack: runError.stack } });
            throw runError; 
        }
        return out.y;
    }
};


function imageDataToFloat32(imageData, dataFormat = 'rgb') {
    const { data, width, height } = imageData;
    const float32Data = new Float32Array(3 * width * height);
    const planeSize = width * height;

    const r_offset = 0;
    const g_offset = 1;
    const b_offset = 2;

    for (let i = 0; i < planeSize; i++) {
        const j = i * 4;
        let r = data[j] / 255.0;
        let g = data[j + 1] / 255.0;
        let b = data[j + 2] / 255.0;

        if (dataFormat === 'bgr') {
            [r, b] = [b, r]; 
        }

        float32Data[i] = r;
        float32Data[i + planeSize] = g;
        float32Data[i + 2 * planeSize] = b;
    }
    return float32Data;
}

function float32ToImageData(float32Data, width, height, dataFormat = 'rgb') {
    const count = width * height;
    const imageData = new ImageData(width, height);
    const clamp = (value) => Math.max(0, Math.min(255, Math.round(value)));

    for (let i = 0; i < count; i++) {
        let r = float32Data[i] * 255;
        let g = float32Data[i + count] * 255;
        let b = float32Data[i + 2 * count] * 255;

        if (dataFormat === 'bgr') {
            [r, b] = [b, r];
        }

        const idx = i * 4;
        imageData.data[idx] = clamp(r);
        imageData.data[idx + 1] = clamp(g);
        imageData.data[idx + 2] = clamp(b);
        imageData.data[idx + 3] = 255;
    }
    return imageData;
}

function crop_tensor(bchw, x, y, width, height) {
    const [B, C, H, W] = bchw.dims;
    const ex = x + width;
    const ey = y + height;
    let roi = new Float32Array(B * C * height * width);
    let i = 0;
    for (let b = 0; b < B; ++b) {
        const bi = b * C * H * W;
        for (let c = 0; c < C; ++c) {
            const ci = bi + c * H * W;
            for (let h = y; h < ey; ++h) {
                const hi = ci + h * W;
                for (let w = x; w < ex; ++w) {
                    roi[i++] = bchw.data[hi + w];
                }
            }
        }
    }
    return new ort.Tensor('float32', roi, [B, C, height, width]);
}

async function padding(x, left, right, top, bottom, mode) {
    const ses = await loadModel(CONFIG.get_helper_model_path(mode + "_pad"));
    left = new ort.Tensor('int64', BigInt64Array.from([left]), []);
    right = new ort.Tensor('int64', BigInt64Array.from([right]), []);
    top = new ort.Tensor('int64', BigInt64Array.from([top]), []);
    bottom = new ort.Tensor('int64', BigInt64Array.from([bottom]), []);
    var out = await ses.run({
        "x": x,
        "left": left, "right": right,
        "top": top, "bottom": bottom
    });
    return out.y;
}


function getModelMethod(arch, scale, noise_level) {
    if (arch === 'x4s') {
        return scale == 4 ? "x4" : null; 
    }

    if (scale == 1) {
        if (noise_level == -1) {
            return null;
        }
        return "noise" + noise_level;

    } else if (scale == 2) {
        if (noise_level == -1) {
            return "scale2x";
        }
        return "noise" + noise_level + "_scale2x";

    } else if (scale == 4) {
        if (noise_level == -1) {
            return "scale4x";
        }
        return "noise" + noise_level + "_scale4x";
    }
    
    return null;
}


const MEMORY_LIMITS = [512, 1024, 2048, 4096, 6144, 8192]; 
try {
    self.importScripts("./libs/ort.min.js");
    ort.env.wasm.wasmPaths = "./";
    if (self.crossOriginIsolated) {
        ort.env.wasm.numThreads = navigator.hardwareConcurrency || 4;
    }
    self.postMessage({ type: 'status', payload: { message: 'AI环境初始化成功，等待任务...' } });
} catch (e) {
    self.postMessage({ type: 'error', payload: { message: '无法加载或配置ONNX.js核心库。', stack: e.stack } });
}

self.onmessage = async (event) => {
    const { type, file, config } = event.data;
    if (type === 'start') {
        try {
            const memoryLimit = MEMORY_LIMITS[config.memoryLevel] || 1024;
            ort.env.wasm.memoryLimit = memoryLimit * 1024 * 1024;

            await upscaleImage(file, config);
            self.postMessage({ type: 'all_done' });

        } catch (error) {
            const errorMessage = (error && error.message) ? error.message : String(error);
            self.postMessage({ type: 'error', payload: { message: errorMessage, stack: error.stack || 'No stack available.' } });
        }
    }
};

async function upscaleImage(file, userConfig) {
    const sourceBitmap = await createImageBitmap(file);
    const { width: sourceWidth, height: sourceHeight } = sourceBitmap;


    const arch = userConfig.waifu2x.arch;
    const style = userConfig.waifu2x.style;
    const noise_level = parseInt(userConfig.waifu2x.noise, 10);
    const scale = parseInt(userConfig.waifu2x.scale, 10);
    let user_tile_size = parseInt(userConfig.tiling.suggestedTileSize, 10);

    const method = getModelMethod(arch, scale, noise_level);
    if (!method) {
        self.postMessage({ type: 'error', payload: { message: '无效的模型配置 (scale/noise)' } });
        return;
    }

    const effective_style = (arch === 'x4s') ? 'photo' : style;
    const model_config = CONFIG.get_config(arch, effective_style, method);
    if (!model_config) {
        self.postMessage({ type: 'error', payload: { message: `找不到模型配置: ${arch}.${style}.${method}` } });
        return;
    }
    

    const model = await loadModel(model_config.path);
    const taskName = model_config.path.split('/').pop();
    self.postMessage({ type: 'status', payload: { message: `模型加载完成` } });

    const offscreenCanvas = new OffscreenCanvas(sourceWidth, sourceHeight);
    const ctx = offscreenCanvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(sourceBitmap, 0, 0);
    const imageData = ctx.getImageData(0, 0, sourceWidth, sourceHeight);
    const x_tensor = new ort.Tensor('float32', imageDataToFloat32(imageData), [1, 3, sourceHeight, sourceWidth]);
    
    if (model_config.arch === 'x4s') {
        self.postMessage({ type: 'status', payload: { message: `使用固定128px切块策略` } });
        
        const TILE_SIZE = 128; 
        const TILE_PAD = model_config.tile_pad; 
        const STEP = TILE_SIZE - TILE_PAD * 2; 

        const cols = sourceWidth > STEP ? Math.ceil((sourceWidth - TILE_PAD * 2) / STEP) : 1;
        const rows = sourceHeight > STEP ? Math.ceil((sourceHeight - TILE_PAD * 2) / STEP) : 1;
        self.postMessage({ type: 'status', payload: { message: `开始处理 ${cols*rows} 个图块...` } });
        const total_tiles = cols * rows;
        let processed_tiles = 0;

        for (let y = 0; y < rows; y++) {
            for (let x = 0; x < cols; x++) {

                const src_x_start = (x === 0) ? 0 : x * STEP - TILE_PAD;
                const src_y_start = (y === 0) ? 0 : y * STEP - TILE_PAD;
                const model_input_data = new Float32Array(3 * TILE_SIZE * TILE_SIZE);
                for (let c = 0; c < 3; c++) {
                    const src_channel_offset = c * sourceHeight * sourceWidth;
                    const dst_channel_offset = c * TILE_SIZE * TILE_SIZE;
                    for (let h = 0; h < TILE_SIZE; h++) {
                        for (let w = 0; w < TILE_SIZE; w++) {
                            const src_h = Math.max(0, Math.min(src_y_start + h, sourceHeight - 1));
                            const src_w = Math.max(0, Math.min(src_x_start + w, sourceWidth - 1));
                            const src_index = src_channel_offset + src_h * sourceWidth + src_w;
                            const dst_index = dst_channel_offset + h * TILE_SIZE + w;
                            model_input_data[dst_index] = x_tensor.data[src_index];
                        }
                    }
                }
                const model_input_tensor = new ort.Tensor('float32', model_input_data, [1, 3, TILE_SIZE, TILE_SIZE]);
                self.postMessage({ type: 'status', payload: { message: `切块完成` } });

                const tile_output = await model.run({ [model_config.input_name]: model_input_tensor });
                const output_tensor = tile_output[model_config.output_name];

                const crop_x_start = (x === 0) ? 0 : TILE_PAD * scale;
                const crop_y_start = (y === 0) ? 0 : TILE_PAD * scale;

                const crop_x_end = (x === cols - 1) ? TILE_SIZE * scale : (TILE_SIZE - TILE_PAD) * scale;
                const crop_y_end = (y === rows - 1) ? TILE_SIZE * scale : (TILE_SIZE - TILE_PAD) * scale;
                
                const cropped_output_tensor = crop_tensor(output_tensor, crop_x_start, crop_y_start, crop_x_end - crop_x_start, crop_y_end - crop_y_start);
                const tileImageData = float32ToImageData(cropped_output_tensor.data, cropped_output_tensor.dims[3], cropped_output_tensor.dims[2]);
                
                const paste_x = (x === 0) ? 0 : (x * STEP - TILE_PAD + TILE_PAD) * scale;
                const paste_y = (y === 0) ? 0 : (y * STEP - TILE_PAD + TILE_PAD) * scale;
                self.postMessage({ type: 'status', payload: { message: `拼接中` } });
                self.postMessage({
                    type: 'tile_done',
                    payload: { data: tileImageData.data.buffer, width: tileImageData.width, height: tileImageData.height, dx: paste_x, dy: paste_y }
                }, [tileImageData.data.buffer]);

                processed_tiles++;
                const progress = processed_tiles / total_tiles;
                self.postMessage({ type: 'progress', payload: { progress: progress, tile: { col: x, row: y, cols: cols, rows: rows }, task: taskName } });
            }
        }
    } else {
        const tile_size = model_config.calc_tile_size(user_tile_size, model_config);
        self.postMessage({ type: 'status', payload: { message: `采用无缝拼接策略...` } });
        const seam_blending = new SeamBlending(x_tensor.dims, model_config.scale, model_config.offset, tile_size);
        await seam_blending.build();
        self.postMessage({ type: 'status', payload: { message: `图像边缘填充...` } });
        const p = seam_blending.get_rendering_config();
        const x_padded = await padding(x_tensor, BigInt(p.pad[0]), BigInt(p.pad[1]), BigInt(p.pad[2]), BigInt(p.pad[3]), model_config.padding);
        
        let tiles = [];
        for (var h_i = 0; h_i < p.h_blocks; ++h_i) {
            for (var w_i = 0; w_i < p.w_blocks; ++w_i) {
                const i = h_i * p.input_tile_step;
                const j = w_i * p.input_tile_step;
                const ii = h_i * p.output_tile_step;
                const jj = w_i * p.output_tile_step;
                tiles.push([i, j, ii, jj, h_i, w_i]);
            }
        }
        if (tiles.length === 0) {
            self.postMessage({ type: 'error', payload: { message: '计算出的图块数量为0，请检查图像尺寸或图块设置。' } });
            return;
        }
        self.postMessage({ type: 'status', payload: { message: `开始处理 ${tiles.length} 个图块...` } });
        for (var k = 0; k < tiles.length; ++k) {
            const [i, j, ii, jj, h_i, w_i] = tiles[k];
            let tile_x = crop_tensor(x_padded, j, i, tile_size, tile_size);
            var tile_output = await model.run({ [model_config.input_name]: tile_x });
            var tile_y = tile_output[model_config.output_name];
            const blended_output = seam_blending.update(tile_y, h_i, w_i);
            const blendedImageData = float32ToImageData(blended_output.data, blended_output.dims[2], blended_output.dims[1]);

            self.postMessage({
                type: 'tile_done',
                payload: { data: blendedImageData.data.buffer, width: blendedImageData.width, height: blendedImageData.height, dx: jj, dy: ii }
            }, [blendedImageData.data.buffer]);

            const progress = (k + 1) / tiles.length;
            self.postMessage({ type: 'progress', payload: { progress: progress, tile: { col: w_i, row: h_i, cols: p.w_blocks, rows: p.h_blocks }, task: taskName } });
        }
    }

    self.postMessage({ type: 'all_done' });
}

