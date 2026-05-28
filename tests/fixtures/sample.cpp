// Unreal-Engine-style implementation fixture.
// Exercises:
//   - out-of-line method definitions (`APickupItem::OnPickedUp`)
//   - field_expression call (`MeshComponent->SetVisibility`)
//   - qualified_identifier call (`UGameplayStatics::SpawnEmitterAtLocation`)
//   - #include resolution as "imports"

#include "sample.h"
#include "Kismet/GameplayStatics.h"

APickupItem::APickupItem()
    : MeshComponent(nullptr)
    , ItemValue(10.0f)
{
}

void APickupItem::BeginPlay()
{
    PlayPickupSound();
}

void APickupItem::Tick(float DeltaSeconds)
{
}

void APickupItem::OnPickedUp(APlayerCharacter* PickerUpper)
{
    PlayPickupSound();
    DestroyPickup();
}

float APickupItem::GetValue() const
{
    return ItemValue;
}

void APickupItem::PlayPickupSound()
{
    // Simulated call to an engine subsystem
    UGameplayStatics::PlaySound2D(this, nullptr);
}

void APickupItem::DestroyPickup()
{
    // Another engine subsystem call via qualified identifier
    UGameplayStatics::SpawnEmitterAtLocation(this, nullptr);
}
