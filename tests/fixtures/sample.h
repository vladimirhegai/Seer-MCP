// Unreal-Engine-style header fixture for Strata smoke tests.
// Mimics the shape of an AActor subclass with UCLASS/UPROPERTY/UFUNCTION
// macros (which tree-sitter-cpp tolerates as preprocessor noise).

#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Actor.h"

class UStaticMeshComponent;

class APickupItem : public AActor
{
public:
    APickupItem();

    void OnPickedUp(class APlayerCharacter* PickerUpper);
    float GetValue() const;

protected:
    virtual void BeginPlay() override;
    virtual void Tick(float DeltaSeconds) override;

private:
    void PlayPickupSound();
    void DestroyPickup();

    UStaticMeshComponent* MeshComponent;
    float ItemValue;
};
