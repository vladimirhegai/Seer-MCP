// Godot-style C# fixture for Strata smoke tests.
// Models a Player CharacterBody2D the way Godot 4's C# bindings expose it.
// Exercises:
//   - method_declaration with overrides
//   - object_creation_expression (`new Vector2(...)`)
//   - invocation_expression via member_access (`Input.GetVector(...)`)
//   - using_directive imports

using System;
using Godot;

public partial class Player : CharacterBody2D
{
    [Export]
    public float Speed = 300.0f;

    private InventoryService inventory;

    public override void _Ready()
    {
        inventory = new InventoryService();
        ResetState();
    }

    public override void _PhysicsProcess(double delta)
    {
        Vector2 direction = Input.GetVector("left", "right", "up", "down");
        ApplyMovement(direction, (float)delta);
        MoveAndSlide();
    }

    private void ApplyMovement(Vector2 direction, float delta)
    {
        Velocity = direction * Speed;
    }

    private void ResetState()
    {
        inventory.Clear();
        Velocity = new Vector2(0, 0);
    }
}

public class InventoryService
{
    private int itemCount;

    public InventoryService()
    {
        itemCount = 0;
    }

    public void Clear()
    {
        itemCount = 0;
    }

    public int GetItemCount()
    {
        return itemCount;
    }
}
