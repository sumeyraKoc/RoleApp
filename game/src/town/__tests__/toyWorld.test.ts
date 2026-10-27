import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { buildIsles } from "../islesMap";
import { buildTown, isUpperBlock } from "../townMap";
import { ToyWorld } from "../toyWorld";

const meshes = (group: THREE.Group) => group.children.filter((c): c is THREE.Mesh => c instanceof THREE.Mesh);
const instanceCount = (group: THREE.Group) =>
  group.children.filter((c): c is THREE.InstancedMesh => c instanceof THREE.InstancedMesh).reduce((n, m) => n + m.count, 0);

describe("ToyWorld (low-poly look)", () => {
  it("draws the town's base with trees and decoration but no roofs", () => {
    const town = buildTown();
    const toy = new ToyWorld(town);
    const base = toy.build((x, y, z) => !town.buildings.some((b) => isUpperBlock(b, x, y, z)), true);
    expect(meshes(base).length).toBeGreaterThan(1);
    // 12 trees x 5 crown blobs at least, plus bushes, tufts and flowers.
    expect(instanceCount(base)).toBeGreaterThan(60);
  });

  it("gives every building with a roof a sloped roof in its upper part", () => {
    const town = buildTown();
    const toy = new ToyWorld(town);
    for (const b of town.buildings.filter((s) => s.roof)) {
      const upper = toy.build((x, y, z) => isUpperBlock(b, x, y, z), false);
      const roof = meshes(upper).find((m) => (m.material as THREE.Material).side === THREE.DoubleSide);
      expect(roof, b.id).toBeDefined();
      roof!.geometry.computeBoundingBox();
      // The ridge rises well above the eaves.
      expect(roof!.geometry.boundingBox!.max.y).toBeGreaterThan(b.roof!.y + 1.3);
    }
  });

  it("builds the isles, including water", () => {
    const isles = buildIsles();
    const toy = new ToyWorld(isles);
    const base = toy.build((x, y, z) => !isles.buildings.some((b) => isUpperBlock(b, x, y, z)), true);
    const transparent = meshes(base).filter((m) => (m.material as THREE.Material).transparent);
    expect(transparent.length).toBeGreaterThan(0);
  });
});
