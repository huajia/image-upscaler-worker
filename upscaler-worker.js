/* 
=========================================================================
== upscaler-worker.js (V7 - 正确实现 SeamBlending 与实时进度)
=========================================================================
*/
console.log('[WORKER] ONNX.js Worker 脚本启动 (SeamBlending + 实时进度版)');

// --- 配置区 
const BLEND_SIZE = 16;

// --- CONFIG 
function gen_arch_config() {
    var config = {};
    /* swin_unet */
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
            arch: "swin_unet", domain: domain, calc_tile_size: calc_tile_size_swin_unet
        };
        swin[domain] = {
            scale2x: { ...base_config, scale: 2, offset: 16 },
            scale4x: { ...base_config, scale: 4, offset: 32 },
            scale1x: { ...base_config, scale: 1, offset: 8 }, // bypass for alpha denoise
        };
        for (var i = 0; i < 4; ++i) {
            swin[domain]["noise" + i + "_scale2x"] = { ...base_config, scale: 2, offset: 16 };
            swin[domain]["noise" + i + "_scale4x"] = { ...base_config, scale: 4, offset: 32 };
            swin[domain]["noise" + i] = { ...base_config, scale: 1, offset: 8 };
        }
    }
    /* cunet */
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
    };
    config["cunet"]["art"] = {
        scale2x: { ...base_config, scale: 2, offset: 36 },
        scale1x: { ...base_config, scale: 1, offset: 28 }, // bypass for alpha denoise
    };
    var base = config["cunet"];
    for (var i = 0; i < 4; ++i) {
        base["art"]["noise" + i + "_scale2x"] = { ...base_config, scale: 2, offset: 36 };
        base["art"]["noise" + i] = { ...base_config, scale: 1, offset: 28 };
    }
    return config;
}

const CONFIG = {
    arch: gen_arch_config(),
    get_config: function (arch, style, method) {
        if ((arch in this.arch) && (style in this.arch[arch]) && (method in this.arch[arch][style])) {
            config = this.arch[arch][style][method];
            // --- 调整路径 ---
            config["path"] = `./models/waifu2x/${arch}/${style}/${method}.onnx`;
            return config;
        } else {
            return null;
        }
    },
    // --- 调整路径 ---
    get_helper_model_path: function (name) {
        return `./models/waifu2x/utils/${name}.onnx`;
    }
};

// --- ONNX Session 管理 (简化版) ---
let modelCache = {};
async function loadModel(modelPath) {
    if (modelCache[modelPath]) return modelCache[modelPath];
    self.postMessage({ type: 'status', payload: { message: `加载模型: ${modelPath.split('/').pop()}` } });
    const response = await fetch(modelPath);
    if (!response.ok) throw new Error(`模型文件加载失败 (${modelPath}): ${response.statusText}`);
    const modelBuffer = await response.arrayBuffer();
    const session = await ort.InferenceSession.create(modelBuffer, {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all'
    });
    modelCache[modelPath] = session;
    return session;
}

// --- SeamBlending 类 (从 unlimited.waifu2x 复制) ---
const SeamBlending = class {
    constructor(x_size, scale, offset, tile_size, blend_size = BLEND_SIZE) {
        this.x_size = x_size;
        this.scale = scale;
        this.offset = offset;
        this.tile_size = tile_size;
        this.blend_size = blend_size;
    }
    async build() {
        console.log("[WORKER] SeamBlending.build 开始计算参数...", {
            x_size: this.x_size,
            scale: this.scale,
            offset: this.offset,
            tile_size: this.tile_size,
            blend_size: this.blend_size
        });
        this.param = SeamBlending.calc_parameters(
            this.x_size, this.scale, this.offset, this.tile_size, this.blend_size);
        console.log("[WORKER] SeamBlending.build 参数计算完成:", this.param);
    
        // 检查参数是否有效
        if (this.param.h_blocks <= 0 || this.param.w_blocks <= 0) {
             console.error("[WORKER] SeamBlending.build: 计算出的图块数量无效!", this.param);
             throw new Error("SeamBlending 参数错误：图块数量非正数");
        }
    
        console.log("[WORKER] SeamBlending.build 初始化像素和权重缓冲区...");
        // NOTE: Float32Array is initialized by 0
        this.pixels = new ort.Tensor(
            'float32',
            new Float32Array(this.param.y_buffer_h * this.param.y_buffer_w * 3),
            [3, this.param.y_buffer_h, this.param.y_buffer_w]);
        this.weights = new ort.Tensor(
            'float32',
            new Float32Array(this.param.y_buffer_h * this.param.y_buffer_w * 3),
            [3, this.param.y_buffer_h, this.param.y_buffer_w]);
    
        console.log("[WORKER] SeamBlending.build 调用 create_seam_blending_filter...");
        this.blend_filter = await this.create_seam_blending_filter();
        console.log("[WORKER] SeamBlending.build blend_filter 创建完成, dims:", this.blend_filter.dims);
    
        // 注意：这里创建一个临时的 output tensor，用于 update 返回
        this.output = new ort.Tensor(
            'float32',
            new Float32Array(this.blend_filter.data.length),
            this.blend_filter.dims);
        console.log("[WORKER] SeamBlending.build 完成");
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
                    // 避免除以零
                    if (next_weight > 0) {
                        old_weight = old_weight / next_weight;
                        new_weight = 1.0 - old_weight;
                        this.pixels.data[buffer_index] = (this.pixels.data[buffer_index] * old_weight +
                            x.data[tile_index] * new_weight);
                    } else {
                        this.pixels.data[buffer_index] = x.data[tile_index]; // Initial value
                    }
                    this.weights.data[buffer_index] += this.blend_filter.data[tile_index];
                    // 将融合后的像素值写入 output tensor 以供返回
                    this.output.data[tile_index] = this.pixels.data[buffer_index];
                }
            }
        }
        return this.output; // 返回融合后的当前图块区域
    }
    get_rendering_config() {
        return this.param;
    }
    static calc_parameters(x_size, scale, offset, tile_size, blend_size) {
        // from nunif/utils/seam_blending.py
        let p = {};
        const x_h = x_size[2];
        const x_w = x_size[3];
        p.y_h = x_h * scale;
        p.y_w = x_w * scale;
        p.input_offset = Math.ceil(offset / scale);
        p.input_blend_size = Math.ceil(blend_size / scale);
        p.input_tile_step = tile_size - (p.input_offset * 2 + p.input_blend_size);
    
        // --- 关键修改：处理 input_tile_step <= 0 的情况 ---
        if (p.input_tile_step <= 0) {
            console.warn("[WORKER] SeamBlending: input_tile_step 非正数，调整为整图处理模式。",
                         { original_tile_size: tile_size, input_offset: p.input_offset, input_blend_size: p.input_blend_size, calculated_input_tile_step: p.input_tile_step });
    
            // --- 关键修改：使用原始图像尺寸作为等效 tile_size ---
            // 这样 create_seam_blending_filter 会基于实际图像大小生成滤镜，而不是一个巨大的虚拟 tile
            const effective_tile_size_for_filter = Math.max(x_h, x_w) + 2 * p.input_offset; // 使用 padded 后的尺寸可能更合理，或直接用 Math.max(x_h, x_w)
            console.log("[WORKER] SeamBlending: 为 create_seam_blending_filter 使用的等效 tile_size:", effective_tile_size_for_filter);
    
            // 用于计算其他参数的 tile_size 仍然可以是原始传入的，或者我们用一个能使其刚好整图的值
            // 但为了简单和一致性，我们直接用图像尺寸计算 input_tile_step
            // 如果整图，input_tile_step 就是图像尺寸
            p.input_tile_step = Math.max(x_h, x_w); // 或者 Math.min(x_h, x_w) 看哪个更合适，但通常用 max
            p.output_tile_step = p.input_tile_step * scale;
    
            p.h_blocks = 1;
            p.w_blocks = 1;
    
            // 缓冲区大小需要能容纳整个 padded 图像
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
    
            // --- 新增：存储用于滤镜计算的等效 tile_size ---
            p.effective_tile_size_for_filter = effective_tile_size_for_filter;
    
            console.log("[WORKER] SeamBlending: 调整后的参数", p);
            return p; // 直接返回
        }
        // --- /关键修改 ---
    
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
        // --- 新增：正常流程也存储这个值 ---
        p.effective_tile_size_for_filter = tile_size;
        return p;
    }
    async create_seam_blending_filter() {
        console.log("[WORKER] create_seam_blending_filter 开始加载模型...");
        const ses = await loadModel(CONFIG.get_helper_model_path("create_seam_blending_filter"));
        console.log("[WORKER] create_seam_blending_filter 模型加载完成");
    
        // --- 关键修改：使用 param 中存储的等效 tile_size ---
        const tile_size_to_use = this.param.effective_tile_size_for_filter !== undefined ? this.param.effective_tile_size_for_filter : this.tile_size;
        console.log("[WORKER] create_seam_blending_filter 准备输入张量...", {
            scale: this.scale,
            offset: this.offset,
            original_tile_size: this.tile_size,
            tile_size_used: tile_size_to_use
        });
    
        let scale_tensor = new ort.Tensor('int64', BigInt64Array.from([BigInt(this.scale)]), []);
        let offset_tensor = new ort.Tensor('int64', BigInt64Array.from([BigInt(this.offset)]), []);
        // --- 使用新的 tile_size ---
        let tile_size_tensor = new ort.Tensor('int64', BigInt64Array.from([BigInt(Math.round(tile_size_to_use))]), []); // 确保是整数
        console.log("[WORKER] create_seam_blending_filter 输入张量准备完成");
    
        console.log("[WORKER] create_seam_blending_filter 开始运行模型...");
        let out;
        try {
            out = await ses.run({
                "scale": scale_tensor,
                "offset": offset_tensor,
                "tile_size": tile_size_tensor,
            });
            console.log("[WORKER] create_seam_blending_filter 模型运行完成");
        } catch (runError) {
            console.error("[WORKER] create_seam_blending_filter 模型运行出错:", runError);
            // 尝试获取更具体的错误信息
            let errorMsg = '未知错误';
            if (runError && runError.message) {
                errorMsg = runError.message;
            } else if (typeof runError === 'string') {
                errorMsg = runError;
            } else if (runError && typeof runError.toString === 'function') {
                errorMsg = runError.toString();
            }
            self.postMessage({ type: 'error', payload: { message: `辅助模型运行失败 (create_seam_blending_filter): ${errorMsg}`, stack: runError.stack } });
            throw runError; // Re-throw to stop the process
        }
        return out.y;
    }
};

// --- 图像数据转换 (从 unlimited.waifu2x 复制并简化) ---
function imageDataToFloat32(imageData) {
    const { data, width, height } = imageData;
    const float32Data = new Float32Array(3 * width * height);
    const planeSize = width * height;
    for (let i = 0; i < planeSize; i++) {
        const j = i * 4;
        float32Data[i] = data[j] / 255.0;
        float32Data[i + planeSize] = data[j + 1] / 255.0;
        float32Data[i + 2 * planeSize] = data[j + 2] / 255.0;
        // Alpha 通道被忽略
    }
    return float32Data;
}

function float32ToImageData(float32Data, width, height) {
    const count = width * height;
    const imageData = new ImageData(width, height);
    const clamp = (value) => Math.max(0, Math.min(255, Math.round(value))); // 使用 round 更精确
    for (let i = 0; i < count; i++) {
        const r = float32Data[i] * 255;
        const g = float32Data[i + count] * 255;
        const b = float32Data[i + 2 * count] * 255;
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

// --- Padding 辅助函数 (从 unlimited.waifu2x 复制并简化) ---
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

// --- 获取任务列表 (从 unlimited.waifu2x 复制并简化) ---
function getWaifu2xMethod(scale, noise_level) {
    // ★★★ 这是唯一的修改点 ★★★
    // 将从 UI 收到的 '0' (无降噪) 转换成内部逻辑使用的 -1
    if (noise_level == 0) {
        noise_level = -1;
    }
    // ★★★ 修改结束 ★★★
    
    if (scale == 1) {
        // 现在，当UI选择“无降噪”时，这里的 noise_level 已经是 -1，逻辑正确
        if (noise_level == -1) return null;
        return "noise" + noise_level;
    } else if (scale == 2) {
        if (noise_level == -1) return "scale2x"; // 现在这条路可以被正确走到
        return "noise" + noise_level + "_scale2x";
    } else if (scale == 4) {
        if (noise_level == -1) return "scale4x"; // 这条路也可以
        return "noise" + noise_level + "_scale4x";
    }
    return null;
}

// --- Worker 初始化 ---
const MEMORY_LIMITS = [512, 1024, 2048, 4096]; // MB
try {
    self.importScripts("https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/ort.min.js");
    ort.env.wasm.wasmPaths = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/";
    if (self.crossOriginIsolated) {
        ort.env.wasm.numThreads = navigator.hardwareConcurrency || 4;
    }
    self.postMessage({ type: 'status', payload: { message: 'AI环境初始化成功，等待任务...' } });
} catch (e) {
    self.postMessage({ type: 'error', payload: { message: '无法加载或配置ONNX.js核心库。', stack: e.stack } });
}

// --- Worker 消息处理 ---
self.onmessage = async (event) => {
    const { type, file, config } = event.data;
    if (type === 'start') {
        try {
            const memoryLimit = MEMORY_LIMITS[config.memoryLevel] || 1024;
            ort.env.wasm.memoryLimit = memoryLimit * 1024 * 1024;
            console.log(`[WORKER] 设置内存限制: ${memoryLimit} MB`);

            await upscaleImage(file, config);
            self.postMessage({ type: 'all_done' });

        } catch (error) {
            console.error('[WORKER] 任务执行期间发生错误:', error);
            const errorMessage = (error && error.message) ? error.message : String(error);
            self.postMessage({ type: 'error', payload: { message: errorMessage, stack: error.stack || 'No stack available.' } });
        }
    }
};

// --- 主处理函数 (基于 unlimited.waifu2x 的 tiled_render) ---
async function upscaleImage(file, userConfig) {
    const sourceBitmap = await createImageBitmap(file);
    const { width: sourceWidth, height: sourceHeight } = sourceBitmap;

    // 1. 解析配置
    const arch = userConfig.waifu2x.arch;
    const style = userConfig.waifu2x.style;
    const noise_level = parseInt(userConfig.waifu2x.noise, 10);
    const scale = parseInt(userConfig.waifu2x.scale, 10);
    const user_tile_size = parseInt(userConfig.tiling.suggestedTileSize, 10);

    const method = getWaifu2xMethod(scale, noise_level);
    if (!method) {
        self.postMessage({ type: 'error', payload: { message: '无效的模型配置 (scale/noise)' } });
        return;
    }

    const model_config = CONFIG.get_config(arch, style, method);
    if (!model_config) {
        self.postMessage({ type: 'error', payload: { message: `找不到模型配置: ${arch}.${style}.${method}` } });
        return;
    }

    // 2. 计算实际 tile_size 和其他参数
    const tile_size = model_config.calc_tile_size(user_tile_size, model_config);
    self.postMessage({ type: 'status', payload: { message: `计算图块尺寸: ${user_tile_size} -> ${tile_size}` } });
    
    // 3. 加载模型
    const model = await loadModel(model_config.path);
    const taskName = model_config.path.split('/').pop();
    self.postMessage({ type: 'status', payload: { message: `模型加载完成: ${taskName}` } });

    // 4. 图像预处理
    const offscreenCanvas = new OffscreenCanvas(sourceWidth, sourceHeight);
    const ctx = offscreenCanvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(sourceBitmap, 0, 0);
    const imageData = ctx.getImageData(0, 0, sourceWidth, sourceHeight);
    let x_tensor = new ort.Tensor('float32', imageDataToFloat32(imageData), [1, 3, sourceHeight, sourceWidth]);

    // 5. 初始化 SeamBlending
    const seam_blending = new SeamBlending(x_tensor.dims, model_config.scale, model_config.offset, tile_size);
    try {
        await seam_blending.build();
    } catch (buildError) {
        throw buildError;
    }
    const p = seam_blending.get_rendering_config();

    // ★ 核心修改: 发送最精确的网格信息给主线程
    self.postMessage({
        type: 'grid_info',
        payload: {
            cols: p.w_blocks,
            rows: p.h_blocks,
            // 这是带重叠区的完整图块大小
            tileWidth: seam_blending.blend_filter.dims[3], // 宽度在第4个维度
            tileHeight: seam_blending.blend_filter.dims[2], // 高度在第3个维度
            // 这是不含重叠区的步进距离
            stepX: p.output_tile_step,
            stepY: p.output_tile_step
        }
    });

    // 6. 对整个图像进行 Padding
    x_tensor = await padding(x_tensor, BigInt(p.pad[0]), BigInt(p.pad[1]), BigInt(p.pad[2]), BigInt(p.pad[3]), model_config.padding);

    // 7. 图块处理循环
    self.postMessage({ type: 'progress', payload: { progress: 0, tile: null, task: taskName } });

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

    for (var k = 0; k < tiles.length; ++k) {
        const [i, j, ii, jj, h_i, w_i] = tiles[k];
        let tile_x = crop_tensor(x_tensor, j, i, tile_size, tile_size);
        var tile_output = await model.run({ x: tile_x });
        var tile_y = tile_output.y;
        const blended_output = seam_blending.update(tile_y, h_i, w_i);
        const blendedImageData = float32ToImageData(blended_output.data, blended_output.dims[2], blended_output.dims[1]);

        self.postMessage({
            type: 'tile_done',
            payload: {
                data: blendedImageData.data.buffer,
                width: blendedImageData.width,
                height: blendedImageData.height,
                dx: jj,
                dy: ii
            }
        }, [blendedImageData.data.buffer]);

        const progress = (k + 1) / tiles.length;
        self.postMessage({
            type: 'progress',
            payload: {
                progress: progress,
                tile: { col: w_i, row: h_i, cols: p.w_blocks, rows: p.h_blocks },
                task: taskName
            }
        });
    }

    self.postMessage({ type: 'all_done' });
}
