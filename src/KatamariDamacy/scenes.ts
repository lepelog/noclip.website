
import * as Viewer from '../viewer';
import { GfxDevice, GfxBindingLayoutDescriptor, GfxHostAccessPass, GfxRenderPass } from "../gfx/platform/GfxPlatform";
import { DataFetcher } from "../DataFetcher";
import * as BIN from "./bin";
import { BINModelInstance, BINModelSectorData, KatamariDamacyTextureHolder, KatamariDamacyProgram } from './render';
import { mat4, vec3 } from 'gl-matrix';
import * as UI from '../ui';
import ArrayBufferSlice from '../ArrayBufferSlice';
import { assert, assertExists } from '../util';
import { fillMatrix4x4 } from '../gfx/helpers/UniformBufferHelpers';
import { Camera, CameraController } from '../Camera';
import { ColorTexture, BasicRenderTarget, standardFullClearRenderPassDescriptor } from '../gfx/helpers/RenderTargetHelpers';
import { TextureOverride } from '../TextureHolder';
import { SceneContext } from '../SceneBase';
import { GfxRenderInstManager } from '../gfx/render/GfxRenderer';
import { GfxRenderHelper } from '../gfx/render/GfxRenderGraph';
import { gsMemoryMapNew } from '../Common/PS2/GS';
import { drawWorldSpacePoint, getDebugOverlayCanvas2D } from '../DebugJunk';
import { getMatrixTranslation } from '../MathHelpers';
import { ObjectRenderer } from './objects';

const pathBase = `katamari_damacy`;

interface StageAreaFileGroup {
    texFile: string;
    modelFile: string;
}

class LevelCache {
    private filePromiseCache = new Map<string, Promise<ArrayBufferSlice>>();
    private fileDataCache = new Map<string, ArrayBufferSlice>();

    constructor(private dataFetcher: DataFetcher) {
    }

    public waitForLoad(): Promise<any> {
        const v: Promise<any>[] = [... this.filePromiseCache.values()];
        return Promise.all(v);
    }

    private fetchFile(path: string): Promise<ArrayBufferSlice> {
        assert(!this.filePromiseCache.has(path));
        const p = this.dataFetcher.fetchData(path);
        this.filePromiseCache.set(path, p);
        return p;
    }

    public fetchFileData(path: string): void {
        const p = this.filePromiseCache.get(path);
        if (p === undefined) {
            this.fetchFile(path).then((data) => {
                this.fileDataCache.set(path, data);
            });
        }
    }

    public getFileData(path: string): ArrayBufferSlice {
        return assertExists(this.fileDataCache.get(path));
    }
}

function getStageAreaFilePath(filename: string): string {
    return `${pathBase}/1879b0/${filename}.bin`;
}

function getMissionSetupFilePath(filename: string): string {
    return `${pathBase}/17f590/${filename}.bin`;
}

class StageAreaSector {
    public modelInstance: BINModelInstance[] = [];
}

class StageAreaRenderer {
    public stageAreaSector: StageAreaSector[] = [];
    public modelInstance: BINModelInstance[] = [];

    constructor(private areaIndex: number) {
    }

    public prepareToRender(renderInstManager: GfxRenderInstManager, textureHolder: KatamariDamacyTextureHolder, viewRenderer: Viewer.ViewerRenderInput) {
        for (let i = 0; i < this.modelInstance.length; i++)
            this.modelInstance[i].prepareToRender(renderInstManager, textureHolder, viewRenderer);
    }

    public setVisible(visible: boolean): void {
        for (let i = 0; i < this.modelInstance.length; i++)
            this.modelInstance[i].setVisible(visible);
    }

    public setActiveAreaNo(areaNo: number): void {
        this.setVisible(areaNo === this.areaIndex);
    }
}

function fillSceneParamsData(d: Float32Array, camera: Camera, offs: number = 0): void {
    offs += fillMatrix4x4(d, offs, camera.projectionMatrix);
}

const bindingLayouts: GfxBindingLayoutDescriptor[] = [
    { numUniformBuffers: 2, numSamplers: 1 },
];

class KatamariDamacyRenderer implements Viewer.SceneGfx {
    private currentAreaNo: number = 0;
    private sceneTexture = new ColorTexture();
    public renderTarget = new BasicRenderTarget();
    public renderHelper: GfxRenderHelper;
    public modelSectorData: BINModelSectorData[] = [];
    public textureHolder = new KatamariDamacyTextureHolder();
    public missionSetupBin: BIN.LevelSetupBIN;

    public stageAreaRenderers: StageAreaRenderer[] = [];
    public objectRenderers: ObjectRenderer[] = [];

    public sceneMoveSpeedMult = 8/60;

    constructor(device: GfxDevice) {
        this.renderHelper = new GfxRenderHelper(device);
    }

    public adjustCameraController(c: CameraController) {
        c.setSceneMoveSpeedMult(this.sceneMoveSpeedMult);
    }

    public render(device: GfxDevice, viewerInput: Viewer.ViewerRenderInput): GfxRenderPass {
        const hostAccessPass = device.createHostAccessPass();
        this.prepareToRender(device, hostAccessPass, viewerInput);
        device.submitPass(hostAccessPass);

        this.sceneTexture.setParameters(device, viewerInput.backbufferWidth, viewerInput.backbufferHeight);
        const tvTextureOverride: TextureOverride = { gfxTexture: this.sceneTexture.gfxTexture!, width: viewerInput.backbufferWidth, height: viewerInput.backbufferHeight, flipY: true };
        if (this.textureHolder.hasTexture('0290/0000/0000'))
            this.textureHolder.setTextureOverride('0290/0000/0000', tvTextureOverride);
        if (this.textureHolder.hasTexture('01c6/0000/0000'))
            this.textureHolder.setTextureOverride('01c6/0000/0000', tvTextureOverride);

        this.renderTarget.setParameters(device, viewerInput.backbufferWidth, viewerInput.backbufferHeight);

        const passRenderer = this.renderTarget.createRenderPass(device, viewerInput.viewport, standardFullClearRenderPassDescriptor, this.sceneTexture.gfxTexture);

        this.renderHelper.renderInstManager.drawOnPassRenderer(device, passRenderer);
        this.renderHelper.renderInstManager.resetRenderInsts();

        return passRenderer;
    }

    public serializeSaveState(dst: ArrayBuffer, offs: number): number {
        const view = new DataView(dst);
        view.setUint8(offs++, this.currentAreaNo);
        return offs;
    }

    public deserializeSaveState(src: ArrayBuffer, offs: number, byteLength: number): number {
        const view = new DataView(src);
        if (offs < byteLength)
            this.setCurrentAreaNo(view.getUint8(offs++));
        return offs;
    }

    public prepareToRender(device: GfxDevice, hostAccessPass: GfxHostAccessPass, viewerInput: Viewer.ViewerRenderInput): void {
        const template = this.renderHelper.pushTemplateRenderInst();
        template.setBindingLayouts(bindingLayouts);
        const offs = template.allocateUniformBuffer(KatamariDamacyProgram.ub_SceneParams, 16);
        const sceneParamsMapped = template.mapUniformBufferF32(KatamariDamacyProgram.ub_SceneParams);
        fillSceneParamsData(sceneParamsMapped, viewerInput.camera, offs);

        for (let i = 0; i < this.stageAreaRenderers.length; i++)
            this.stageAreaRenderers[i].prepareToRender(this.renderHelper.renderInstManager, this.textureHolder, viewerInput);
        for (let i = 0; i < this.objectRenderers.length; i++)
            this.objectRenderers[i].prepareToRender(this.renderHelper.renderInstManager, this.textureHolder, viewerInput);

        this.renderHelper.renderInstManager.popTemplateRenderInst();
        this.renderHelper.prepareToRender(device, hostAccessPass);
    }

    public setCurrentAreaNo(areaNo: number): void {
        this.currentAreaNo = areaNo;
        for (let i = 0; i < this.stageAreaRenderers.length; i++)
            this.stageAreaRenderers[i].setActiveAreaNo(areaNo);
        for (let i = 0; i < this.objectRenderers.length; i++)
            this.objectRenderers[i].setActiveAreaNo(areaNo);
    }

    public createPanels(): UI.Panel[] {
        const areasPanel = new UI.Panel();
        areasPanel.setTitle(UI.LAYER_ICON, 'Areas');
        areasPanel.customHeaderBackgroundColor = UI.COOL_BLUE_COLOR;

        const areaSelect = new UI.SingleSelect();
        areaSelect.setStrings(this.stageAreaRenderers.map((renderer, i) => `Area ${i+1}`));
        areaSelect.onselectionchange = (index: number) => {
            const areaNo = this.missionSetupBin.activeStageAreas[index];
            this.setCurrentAreaNo(areaNo);
        };
        areaSelect.selectItem(this.currentAreaNo);
        areasPanel.contents.appendChild(areaSelect.elem);

        return [areasPanel];
    }

    public destroy(device: GfxDevice): void {
        this.sceneTexture.destroy(device);
        this.renderTarget.destroy(device);
        this.textureHolder.destroy(device);
        this.renderHelper.destroy(device);

        for (let i = 0; i < this.modelSectorData.length; i++)
            this.modelSectorData[i].destroy(device);
    }
}

const katamariWorldSpaceToNoclipSpace = mat4.create();
mat4.rotateX(katamariWorldSpaceToNoclipSpace, katamariWorldSpaceToNoclipSpace, Math.PI);

class KatamariLevelSceneDesc implements Viewer.SceneDesc {
    constructor(public id: string, private index: number, public name: string, public stageAreaFileGroup: StageAreaFileGroup[], public missionSetupFile: string[], public initialAreaNo: number = -1, public cameraSpeedMult: number = 1) {
    }

    public createScene(device: GfxDevice, context: SceneContext): Promise<Viewer.SceneGfx> {
        const dataFetcher = context.dataFetcher;
        const cache = new LevelCache(dataFetcher);

        for (let i = 0; i < this.stageAreaFileGroup.length; i++) {
            cache.fetchFileData(getStageAreaFilePath(this.stageAreaFileGroup[i].texFile));
            cache.fetchFileData(getStageAreaFilePath(this.stageAreaFileGroup[i].modelFile));
        }

        for (let i = 0; i < this.missionSetupFile.length; i++) {
            cache.fetchFileData(getMissionSetupFilePath(this.missionSetupFile[i]));
        }

        cache.fetchFileData(`${pathBase}/transformBlock.bin`); // 0x111260 to 0x112FFC from the ELF
        cache.fetchFileData(`${pathBase}/randomBlock.bin`); // 0x116980 to 0x1171C8 from the ELF

        return cache.waitForLoad().then(() => {
            const gsMemoryMap = gsMemoryMapNew();

            const renderer = new KatamariDamacyRenderer(device);
            renderer.sceneMoveSpeedMult *= this.cameraSpeedMult;
            const gfxCache = renderer.renderHelper.getCache();

            // Parse through the mission setup data to get our stage spawns.
            const buffers: ArrayBufferSlice[] = [];
            for (let i = 0; i < this.missionSetupFile.length; i++)
                buffers.push(cache.getFileData(getMissionSetupFilePath(this.missionSetupFile[i])));

            const randomGroups = BIN.initRandomGroups(this.index, cache.getFileData(`${pathBase}/randomBlock.bin`));

            const missionSetupBin = BIN.parseMissionSetupBIN(buffers, gsMemoryMap, randomGroups, cache.getFileData(`${pathBase}/transformBlock.bin`));
            renderer.missionSetupBin = missionSetupBin;

            // Parse our different stages.
            for (let i = 0; i < missionSetupBin.activeStageAreas.length; i++) {
                const stageAreaIndex = missionSetupBin.activeStageAreas[i];

                // TODO(jstpierre): What does it mean to have an "active stage" that's past our level set?
                if (stageAreaIndex >= this.stageAreaFileGroup.length)
                    continue;

                const stageTexBinData = cache.getFileData(getStageAreaFilePath(this.stageAreaFileGroup[stageAreaIndex].texFile));
                const stageModelBinData = cache.getFileData(getStageAreaFilePath(this.stageAreaFileGroup[stageAreaIndex].modelFile));
                BIN.parseStageTextureBIN(stageTexBinData, gsMemoryMap);
                const stageModelBin = BIN.parseLevelModelBIN(stageModelBinData, gsMemoryMap, this.id);

                const stageAreaRenderer = new StageAreaRenderer(stageAreaIndex);

                for (let j = 0; j < stageModelBin.sectors.length; j++) {
                    const sector = stageModelBin.sectors[j];
                    renderer.textureHolder.addBINTexture(device, sector);

                    const stageAreaSector = new StageAreaSector();

                    const binModelSectorData = new BINModelSectorData(device, gfxCache, sector);
                    renderer.modelSectorData.push(binModelSectorData);

                    for (let k = 0; k < sector.models.length; k++) {
                        const binModelInstance = new BINModelInstance(device, gfxCache, renderer.textureHolder, binModelSectorData.modelData[k]);
                        mat4.copy(binModelInstance.modelMatrix, katamariWorldSpaceToNoclipSpace);
                        stageAreaRenderer.modelInstance.push(binModelInstance);
                        stageAreaSector.modelInstance.push(binModelInstance);
                    }

                    stageAreaRenderer.stageAreaSector.push(stageAreaSector);
                }

                renderer.stageAreaRenderers.push(stageAreaRenderer);
            }

            const objectDatas: BINModelSectorData[] = [];
            for (let i = 0; i < missionSetupBin.objectModels.length; i++) {
                const objectModel = missionSetupBin.objectModels[i];
                renderer.textureHolder.addBINTexture(device, objectModel.sector);

                const binModelSectorData = new BINModelSectorData(device, gfxCache, objectModel.sector);
                objectDatas.push(binModelSectorData);
                renderer.modelSectorData.push(binModelSectorData);
            }

            for (let i = 0; i < missionSetupBin.objectSpawns.length; i++) {
                const objectSpawn = missionSetupBin.objectSpawns[i];
                const objectRenderer = new ObjectRenderer(objectSpawn);

                const binModelSectorData = objectDatas[objectSpawn.modelIndex];
                const objectModel = missionSetupBin.objectModels[objectSpawn.modelIndex];
                for (let j = 0; j < binModelSectorData.modelData.length; j++) {
                    const binModelInstance = new BINModelInstance(device, gfxCache, renderer.textureHolder, binModelSectorData.modelData[j]);
                    mat4.mul(binModelInstance.modelMatrix, katamariWorldSpaceToNoclipSpace, objectSpawn.modelMatrix);
                    if (objectModel.transforms.length > 0)
                        mat4.mul(binModelInstance.modelMatrix, binModelInstance.modelMatrix, objectModel.transforms[j]);
                    objectRenderer.modelInstance.push(binModelInstance);
                }

                renderer.objectRenderers.push(objectRenderer);
            }

            if (this.initialAreaNo !== -1)
                renderer.setCurrentAreaNo(missionSetupBin.activeStageAreas[this.initialAreaNo]);

            return renderer;
        });
    }
}

const id = 'katamari_damacy';
const name = 'Katamari Damacy';

const houseStageAreaGroup: StageAreaFileGroup[] = [
    { texFile: '135049', modelFile: '135b75', },
    // The game loads 1350c3, 13513d, 1351b7 as the texture files, but these files are byte-for-byte
    // identical to 135049, so we cut down on loading time here.
    { texFile: '135049', modelFile: '135c43', },
    { texFile: '135049', modelFile: '135d18', },
    { texFile: '135049', modelFile: '135ded', },
];

const cityStageAreaGroup: StageAreaFileGroup[] = [
    // The game loads 135299, 135301, 135369 as the texture files, but these files are byte-for-byte
    // identical to 135231, so we cut down on loading time here.
    { texFile: '135231', modelFile: '135ebf', },
    { texFile: '135231', modelFile: '135fe0', },
    { texFile: '135231', modelFile: '13612f', },
    { texFile: '135231', modelFile: '136282', },
];

const worldStageAreaGroup: StageAreaFileGroup[] = [
    // The game loads 13548c, 134fda as the texture files, but these files are byte-for-byte
    // identical to 1353d1, so we cut down on loading time here.
    { texFile: '1353d1', modelFile: '1363c5', },
    { texFile: '1353d1', modelFile: '1364a3', },
    { texFile: '1353d1', modelFile: '136599', },
    // The next two texture files are not identical.
    { texFile: '135602', modelFile: '1366d7', },
    { texFile: '135745', modelFile: '136797', },
];

const multiplayerStageAreaGroup: StageAreaFileGroup[] = [
    { texFile: '135753', modelFile: '1367a0', },
    { texFile: '135778', modelFile: '1367af', },
    { texFile: '1357a5', modelFile: '1367be', },
];

const sceneDescs = [
    "Planets",
    new KatamariLevelSceneDesc('lvl1',  1,  "Make a Star 1 (House)", houseStageAreaGroup, ['13d9bd', '13da02', '13da55', '13daa6']),
    new KatamariLevelSceneDesc('lvl2',  2,  "Make a Star 2 (House)", houseStageAreaGroup, ['13daff', '13db9c', '13dc59', '13dd08']),
    new KatamariLevelSceneDesc('lvl3',  4,  "Make a Star 3 (City)",  cityStageAreaGroup,  ['13e462', '13e553', '13e68e', '13e7b1']),
    new KatamariLevelSceneDesc('lvl4',  3,  "Make a Star 4 (House)", houseStageAreaGroup, ['13ddc6', '13df3f', '13e10e', '13e2b1']),
    new KatamariLevelSceneDesc('lvl5',  5,  "Make a Star 5 (City)",  cityStageAreaGroup,  ['13e8d2', '13ea87', '13eca3', '13eeb0']),
    new KatamariLevelSceneDesc('lvl6',  6,  "Make a Star 6 (World)", worldStageAreaGroup, ['13f0b4', '13f244', '13f443', '13f605']),
    new KatamariLevelSceneDesc('lvl7',  7,  "Make a Star 7 (World)", worldStageAreaGroup, ['13f7c8', '13f97f', '13fbad', '13fda5']),
    new KatamariLevelSceneDesc('lvl8',  8,  "Make a Star 8 (City)",  cityStageAreaGroup,  ['13ff91', '14017a', '1403d3', '140616']),
    new KatamariLevelSceneDesc('lvl9',  9,  "Make a Star 9 (World)", worldStageAreaGroup, ['140850', '140a3e', '140cc7', '140f02']),
    new KatamariLevelSceneDesc('lvl10', 10, "Make the Moon (World)", worldStageAreaGroup, ['141133', '141339', '1415d4', '141829'], -1, 100),

    "Constellations",
    new KatamariLevelSceneDesc('clvl1', 11, "Make Cancer",           houseStageAreaGroup, ['141ab5', '141b43', '141bf5', '141cae']),
    new KatamariLevelSceneDesc('clvl2', 12, "Make Cygnus",           houseStageAreaGroup, ['141d5d', '141dfb', '141ec1', '141f82']),
    new KatamariLevelSceneDesc('clvl3', 14, "Make Corona Borealis",  cityStageAreaGroup,  ['1422c5', '1423de', '142542', '1426ac']),
    new KatamariLevelSceneDesc('clvl4', 18, "Make Gemini",           worldStageAreaGroup, ['14364f', '143796', '143938', '143aae']),
    new KatamariLevelSceneDesc('clvl5', 17, "Make Ursa Major",       cityStageAreaGroup,  ['14317d', '143287', '1433dc', '143518']),
    new KatamariLevelSceneDesc('clvl6', 19, "Make Taurus",           worldStageAreaGroup, ['143c24', '143d77', '143f34', '1440b8']),
    new KatamariLevelSceneDesc('clvl7', 15, "Make Pisces",           cityStageAreaGroup,  ['142801', '14290d', '142a52', '142b90']),
    new KatamariLevelSceneDesc('clvl8', 16, "Make Virgo",            cityStageAreaGroup,  ['142cc5', '142dd2', '142f0e', '143046']),

    // Make the North Star seems to have a dummy mission setup as the first area... just display the other one by default...
    new KatamariLevelSceneDesc('clvl9', 21, "Make the North Star",  worldStageAreaGroup, ['144633', '1447b1', '1449ba', '144b78'], 1),

    "Multiplayer",
    new KatamariLevelSceneDesc('mplvl1', 31, "Multiplayer Level 1", multiplayerStageAreaGroup, ['1472a8', '1472b8', '1472d6', '1472ef']),
    new KatamariLevelSceneDesc('mplvl2', 32, "Multiplayer Level 2", multiplayerStageAreaGroup, ['147307', '147319', '147334', '147350']),
    new KatamariLevelSceneDesc('mplvl3', 33, "Multiplayer Level 3", multiplayerStageAreaGroup, ['14736c', '147380', '14739a', '1473be']),
    new KatamariLevelSceneDesc('mplvl4', 34, "Multiplayer Level 4", multiplayerStageAreaGroup, ['1473db', '1473ec', '147409', '147429']),
    new KatamariLevelSceneDesc('mplvl5', 35, "Multiplayer Level 5", multiplayerStageAreaGroup, ['147445', '147457', '14746e', '14748c']),

    "Unused Levels",
    new KatamariLevelSceneDesc('snow', 0, "Snow", [
        { texFile: '135042', modelFile: '135adb' },
    ], ['13d9b1', '13d9b3', '13d9b5', '13d9b8']),
];
const sceneIdMap = new Map<string, string>();
// When I first was testing Katamari, I was testing the Tutorial Level. At some point
// I changed to Make a Star 1, but didn't change the ID before pushing live. So that's
// why the level file for the Tutorial maps to Make a Star 1.
sceneIdMap.set('13698a', 'lvl1');
export const sceneGroup: Viewer.SceneGroup = { id, name, sceneDescs, sceneIdMap };
